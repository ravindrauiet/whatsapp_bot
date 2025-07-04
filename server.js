const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Store multiple clients and their status
const clients = new Map();
const clientMessages = new Map();
const clientStatus = new Map();

// Function to create a new client instance
function createClient(clientId) {
    console.log('=== CREATE CLIENT FUNCTION START ===');
    console.log('Creating client with ID:', clientId);
    
    // Ensure sessions directory exists
    const sessionsDir = path.join(__dirname, 'sessions');
    console.log('Sessions directory path:', sessionsDir);
    
    if (!fs.existsSync(sessionsDir)) {
        console.log('Sessions directory does not exist, creating...');
        fs.mkdirSync(sessionsDir, { recursive: true });
        console.log('Created sessions directory');
    } else {
        console.log('Sessions directory already exists');
    }
    
    const clientDir = path.join(sessionsDir, clientId);
    console.log('Client directory path:', clientDir);
    
    if (!fs.existsSync(clientDir)) {
        console.log('Client directory does not exist, creating...');
        fs.mkdirSync(clientDir, { recursive: true });
        console.log(`Created client directory: ${clientDir}`);
    } else {
        console.log('Client directory already exists');
    }
    
    console.log('Creating WhatsApp Client instance...');
    const client = new Client({
        authStrategy: new LocalAuth({
            clientId: clientId,
            dataPath: `./sessions/${clientId}`
        }),
        puppeteer: {
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
        }
    });
    
    console.log('WhatsApp Client instance created successfully');
    
    // Initialize message storage for this client
    clientMessages.set(clientId, []);
    clientStatus.set(clientId, 'disconnected');
    
    console.log('Setting up event handlers for client:', clientId);

    // When the client is ready
    client.once('ready', () => {
        console.log(`Client ${clientId} is ready!`);
        clientStatus.set(clientId, 'connected');
        
        // Get the bot's own number for easy testing
        const botNumber = client.info.wid._serialized;
        
        io.emit('botStatus', { 
            clientId: clientId,
            status: 'connected', 
            qrCode: null,
            botNumber: botNumber
        });
        io.emit('log', { 
            clientId: clientId,
            type: 'success', 
            message: `WhatsApp bot ${clientId} is ready and connected!` 
        });
        io.emit('log', { 
            clientId: clientId,
            type: 'info', 
            message: `Bot number: ${botNumber}` 
        });
    });

    // When the client received QR-Code
    client.on('qr', async (qr) => {
        console.log(`QR RECEIVED for ${clientId}`);
        clientStatus.set(clientId, 'qr_ready');
        try {
            const qrCodeData = await qrcode.toDataURL(qr);
            io.emit('botStatus', { 
                clientId: clientId,
                status: 'qr_ready', 
                qrCode: qrCodeData 
            });
            io.emit('log', { 
                clientId: clientId,
                type: 'info', 
                message: 'QR Code generated. Please scan with WhatsApp.' 
            });
        } catch (error) {
            console.error('Error generating QR code:', error);
        }
    });

    // When the client is disconnected
    client.on('disconnected', (reason) => {
        console.log(`Client ${clientId} was disconnected`, reason);
        clientStatus.set(clientId, 'disconnected');
        io.emit('botStatus', { 
            clientId: clientId,
            status: 'disconnected', 
            qrCode: null 
        });
        io.emit('log', { 
            clientId: clientId,
            type: 'warning', 
            message: `WhatsApp bot ${clientId} disconnected. Please reconnect.` 
        });
    });

    // Listening to all incoming messages
    client.on('message_create', message => {
        // Prevent bot from responding to its own messages
        if (message.fromMe) {
            return;
        }
        
        console.log(`📥 MESSAGE_CREATE from ${message.from} to ${clientId}: ${message.body}`);
        
        // Add message to our store
        const messageData = {
            id: Date.now(),
            clientId: clientId,
            from: message.from,
            body: message.body,
            timestamp: new Date().toLocaleString(),
            type: 'received'
        };
        
        const messages = clientMessages.get(clientId) || [];
        messages.push(messageData);
        clientMessages.set(clientId, messages);
        
        console.log(`📊 Stored message for client ${clientId}. Total messages: ${messages.length}`);
        
        // Emit to frontend
        io.emit('newMessage', messageData);
        console.log(`📤 Emitted newMessage to frontend for client ${clientId}`);
        
        // Handle commands for this specific client
        handleCommands(client, message, clientId).catch(error => {
            console.error(`Error handling commands for client ${clientId}:`, error);
        });
    });



    console.log('Event handlers set up successfully for client:', clientId);
    console.log('=== CREATE CLIENT FUNCTION END ===');
    
    return client;
}

// Function to handle commands for a specific client
async function handleCommands(client, message, clientId) {
    // Method 1: Direct reply to the message (recommended)
    if (message.body === '!ping') {
        message.reply('pong');
        addBotMessage('pong', message.from, clientId);
    }
    
    // Method 2: Send message to the same chat
    else if (message.body === '!hello') {
        client.sendMessage(message.from, 'Hello! How can I help you?');
        addBotMessage('Hello! How can I help you?', message.from, clientId);
    }
    
    // Method 3: Reply with different types of responses
    else if (message.body === '!help') {
        const helpText = `Available commands:
• !ping - Test if bot is working
• !hello - Get a greeting
• !help - Show this help message
• !time - Get current time
• !info - Get message info
• !client - Show which client you're using
• !bulk - Send message to multiple users (see format below)

Bulk message format:
!bulk
RECIPIENT1
RECIPIENT2
---
Your message here`;
        message.reply(helpText);
        addBotMessage(helpText, message.from, clientId);
    }
    
    // Method 4: Reply with current time
    else if (message.body === '!time') {
        const currentTime = new Date().toLocaleString();
        message.reply(`Current time: ${currentTime}`);
        addBotMessage(`Current time: ${currentTime}`, message.from, clientId);
    }
    
    // Method 5: Reply with message information
    else if (message.body === '!info') {
        const info = `Message Info:
• From: ${message.from}
• Type: ${message.type}
• Timestamp: ${message.timestamp}
• Is Group: ${message.from.includes('@g.us')}
• Client: ${clientId}`;
        message.reply(info);
        addBotMessage(info, message.from, clientId);
    }
    
    // Method 6: Reply to specific keywords
    else if (message.body.toLowerCase().includes('hello') || message.body.toLowerCase().includes('hi')) {
        message.reply('👋 Hello! Nice to meet you!');
        addBotMessage('👋 Hello! Nice to meet you!', message.from, clientId);
    }
    
    // Method 7: Reply with emojis and formatting
    else if (message.body === '!emoji') {
        message.reply('😊 🎉 🚀 Here are some emojis for you!');
        addBotMessage('😊 🎉 🚀 Here are some emojis for you!', message.from, clientId);
    }
    
    // Method 8: Show which client is being used
    else if (message.body === '!client') {
        message.reply(`You are using client: ${clientId}`);
        addBotMessage(`You are using client: ${clientId}`, message.from, clientId);
    }
    
    // Method 9: Bulk message command
    else if (message.body.startsWith('!bulk ')) {
        const parts = message.body.split('\n');
        if (parts.length < 3) {
            const helpText = `Bulk message format:
!bulk
RECIPIENT1
RECIPIENT2
---
Your message here

Example:
!bulk
919354156323
919876543210
---
Hello everyone! This is a bulk message.`;
            message.reply(helpText);
            addBotMessage(helpText, message.from, clientId);
            return;
        }
        
        // Find the separator line (---)
        const separatorIndex = parts.findIndex(part => part.trim() === '---');
        if (separatorIndex === -1 || separatorIndex < 2) {
            message.reply('Invalid format. Use "---" to separate recipients from message.');
            addBotMessage('Invalid format. Use "---" to separate recipients from message.', message.from, clientId);
            return;
        }
        
        // Extract recipients and message
        const recipients = parts.slice(1, separatorIndex).map(r => r.trim()).filter(r => r.length > 0);
        const bulkMessage = parts.slice(separatorIndex + 1).join('\n').trim();
        
        if (recipients.length === 0) {
            message.reply('No recipients found. Please provide at least one phone number.');
            addBotMessage('No recipients found. Please provide at least one phone number.', message.from, clientId);
            return;
        }
        
        if (!bulkMessage) {
            message.reply('No message found. Please provide a message after the "---" separator.');
            addBotMessage('No message found. Please provide a message after the "---" separator.', message.from, clientId);
            return;
        }
        
        // Send confirmation
        message.reply(`Starting to send bulk message to ${recipients.length} recipients...`);
        addBotMessage(`Starting to send bulk message to ${recipients.length} recipients...`, message.from, clientId);
        
        // Send messages to each recipient
        let successCount = 0;
        let errorCount = 0;
        
        for (const recipient of recipients) {
            try {
                // Format phone number properly
                let formattedNumber = recipient;
                formattedNumber = formattedNumber.replace(/[^\d@]/g, '');
                
                if (!formattedNumber.includes('@')) {
                    formattedNumber = formattedNumber + '@c.us';
                }
                
                if (!formattedNumber.match(/^\d+@c\.us$/)) {
                    throw new Error(`Invalid phone number format: ${recipient}`);
                }
                
                client.sendMessage(formattedNumber, bulkMessage);
                addBotMessage(bulkMessage, formattedNumber, clientId);
                successCount++;
                
            } catch (error) {
                errorCount++;
                console.error(`Error sending bulk message to ${recipient}:`, error);
            }
            
            // Small delay to avoid rate limiting
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
        // Send completion summary
        const summary = `Bulk message completed! Success: ${successCount}, Failed: ${errorCount}`;
        message.reply(summary);
        addBotMessage(summary, message.from, clientId);
    }
}

// Helper function to add bot messages
function addBotMessage(body, to, clientId) {
    const messageData = {
        id: Date.now(),
        clientId: clientId,
        from: 'Bot',
        to: to,
        body: body,
        timestamp: new Date().toLocaleString(),
        type: 'sent'
    };
    
    const messages = clientMessages.get(clientId) || [];
    messages.push(messageData);
    clientMessages.set(clientId, messages);
    io.emit('newMessage', messageData);
}

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log('=== SOCKET CONNECTION ESTABLISHED ===');
    console.log('Frontend connected with socket ID:', socket.id);
    
    // Send current status for all clients
    clients.forEach((client, clientId) => {
        const status = clientStatus.get(clientId) || 'disconnected';
        const messages = clientMessages.get(clientId) || [];
        socket.emit('botStatus', { 
            clientId: clientId,
            status: status, 
            qrCode: null 
        });
        socket.emit('messages', { clientId: clientId, messages: messages });
    });
    
    // Handle client creation
    socket.on('createClient', async (data) => {
        console.log('=== CLIENT CREATION START ===');
        console.log('Received createClient event with data:', data);
        
        try {
            const { clientId } = data;
            console.log('Extracted clientId:', clientId);
            
            if (!clientId || clientId.trim() === '') {
                console.log('ERROR: Client ID is empty or missing');
                socket.emit('log', { type: 'error', message: 'Client ID is required!' });
                return;
            }
            
            console.log('Checking if client already exists...');
            if (clients.has(clientId)) {
                console.log('ERROR: Client already exists:', clientId);
                socket.emit('log', { type: 'warning', message: `Client ${clientId} already exists!` });
                return;
            }
            
            console.log(`Creating client: ${clientId}`);
            console.log('Current clients Map size:', clients.size);
            
            const client = createClient(clientId);
            console.log('Client object created:', typeof client);
            
            clients.set(clientId, client);
            console.log('Client added to clients Map. New size:', clients.size);
            
            console.log('Emitting success log...');
            socket.emit('log', { type: 'success', message: `Client ${clientId} created successfully!` });
            
            console.log('Emitting clientCreated event...');
            socket.emit('clientCreated', { clientId: clientId });
            
            // Initialize the client
            console.log('Starting client initialization...');
            try {
                await client.initialize();
                console.log(`Client ${clientId} initialization completed successfully`);
                socket.emit('log', { type: 'info', message: `Client ${clientId} initialization started...` });
            } catch (initError) {
                console.error(`Error initializing client ${clientId}:`, initError);
                socket.emit('log', { type: 'error', message: `Failed to initialize client ${clientId}: ${initError.message}` });
            }
            
            console.log('=== CLIENT CREATION END ===');
            
        } catch (error) {
            console.error('=== CLIENT CREATION ERROR ===');
            console.error('Error creating client:', error);
            console.error('Error stack:', error.stack);
            socket.emit('log', { type: 'error', message: 'Failed to create client: ' + error.message });
        }
    });
    
    // Handle manual message sending
    socket.on('sendMessage', async (data) => {
        try {
            const { clientId, to, message } = data;
            
            if (!clientId || !clients.has(clientId)) {
                socket.emit('log', { type: 'error', message: 'Invalid client ID!' });
                return;
            }
            
            const client = clients.get(clientId);
            const status = clientStatus.get(clientId);
            
            if (status === 'connected') {
                // Format phone number properly
                let formattedNumber = to;
                
                // Remove any non-digit characters except @
                formattedNumber = formattedNumber.replace(/[^\d@]/g, '');
                
                // If no @c.us suffix, add it
                if (!formattedNumber.includes('@')) {
                    formattedNumber = formattedNumber + '@c.us';
                }
                
                // Validate phone number format
                if (!formattedNumber.match(/^\d+@c\.us$/)) {
                    throw new Error('Invalid phone number format. Use: 1234567890 or 1234567890@c.us');
                }
                
                await client.sendMessage(formattedNumber, message);
                addBotMessage(message, formattedNumber, clientId);
                socket.emit('log', { type: 'success', message: `Message sent successfully via ${clientId}!` });
            } else {
                socket.emit('log', { type: 'error', message: `Client ${clientId} is not connected!` });
            }
        } catch (error) {
            console.error('Error sending message:', error);
            socket.emit('log', { type: 'error', message: 'Failed to send message: ' + error.message });
        }
    });

    // Handle sending message to multiple users
    socket.on('sendMessageToMultiple', async (data) => {
        try {
            const { clientId, recipients, message } = data;
            
            if (!clientId || !clients.has(clientId)) {
                socket.emit('log', { type: 'error', message: 'Invalid client ID!' });
                return;
            }
            
            if (!recipients || !Array.isArray(recipients) || recipients.length === 0) {
                socket.emit('log', { type: 'error', message: 'Please provide at least one recipient!' });
                return;
            }
            
            if (!message || message.trim() === '') {
                socket.emit('log', { type: 'error', message: 'Please provide a message!' });
                return;
            }
            
            const client = clients.get(clientId);
            const status = clientStatus.get(clientId);
            
            if (status !== 'connected') {
                socket.emit('log', { type: 'error', message: `Client ${clientId} is not connected!` });
                return;
            }
            
            let successCount = 0;
            let errorCount = 0;
            
            socket.emit('log', { type: 'info', message: `Starting to send message to ${recipients.length} recipients via ${clientId}...` });
            
            for (let i = 0; i < recipients.length; i++) {
                const recipient = recipients[i].trim();
                
                try {
                    // Format phone number properly
                    let formattedNumber = recipient;
                    
                    // Remove any non-digit characters except @
                    formattedNumber = formattedNumber.replace(/[^\d@]/g, '');
                    
                    // If no @c.us suffix, add it
                    if (!formattedNumber.includes('@')) {
                        formattedNumber = formattedNumber + '@c.us';
                    }
                    
                    // Validate phone number format
                    if (!formattedNumber.match(/^\d+@c\.us$/)) {
                        throw new Error(`Invalid phone number format: ${recipient}`);
                    }
                    
                    await client.sendMessage(formattedNumber, message);
                    addBotMessage(message, formattedNumber, clientId);
                    successCount++;
                    
                } catch (error) {
                    errorCount++;
                    console.error(`Error sending bulk message to ${recipient}:`, error);
                }
                
                // Small delay to avoid rate limiting
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
            
            // Final summary
            const summary = `Bulk message completed! Success: ${successCount}, Failed: ${errorCount}`;
            socket.emit('log', { type: successCount > 0 ? 'success' : 'warning', message: summary });
            
            // Re-enable the send button
            socket.emit('bulkMessageComplete');
            
        } catch (error) {
            console.error('Error sending bulk message:', error);
            socket.emit('log', { type: 'error', message: 'Failed to send bulk message: ' + error.message });
            socket.emit('bulkMessageComplete');
        }
    });
    
    // Handle bot restart
    socket.on('restartBot', (data) => {
        try {
            const { clientId } = data;
            
            if (!clientId || !clients.has(clientId)) {
                socket.emit('log', { type: 'error', message: 'Invalid client ID!' });
                return;
            }
            
            const client = clients.get(clientId);
            client.destroy();
            client.initialize();
            socket.emit('log', { type: 'info', message: `Client ${clientId} restarting...` });
        } catch (error) {
            socket.emit('log', { type: 'error', message: 'Failed to restart bot: ' + error.message });
        }
    });
    
    // Handle client deletion
    socket.on('deleteClient', (data) => {
        try {
            const { clientId } = data;
            
            if (!clientId || !clients.has(clientId)) {
                socket.emit('log', { type: 'error', message: 'Invalid client ID!' });
                return;
            }
            
            const client = clients.get(clientId);
            client.destroy();
            clients.delete(clientId);
            clientMessages.delete(clientId);
            clientStatus.delete(clientId);
            
            socket.emit('log', { type: 'success', message: `Client ${clientId} deleted successfully!` });
            socket.emit('clientDeleted', { clientId: clientId });
            
        } catch (error) {
            socket.emit('log', { type: 'error', message: 'Failed to delete client: ' + error.message });
        }
    });
    
    // Handle bulk message completion
    socket.on('bulkMessageComplete', () => {
        // Re-enable the send button
        const sendButton = document.querySelector('.bulk-message button');
        sendButton.disabled = false;
        sendButton.textContent = 'Send to All';
    });

    // Handle message refresh request
    socket.on('refreshMessages', (data) => {
        try {
            const { clientId } = data;
            
            if (!clientId || !clients.has(clientId)) {
                socket.emit('log', { type: 'error', message: 'Invalid client ID!' });
                return;
            }
            
            const messages = clientMessages.get(clientId) || [];
            socket.emit('messages', { clientId: clientId, messages: messages });
            socket.emit('log', { type: 'info', message: `Refreshed ${messages.length} messages for client ${clientId}` });
            
        } catch (error) {
            socket.emit('log', { type: 'error', message: 'Failed to refresh messages: ' + error.message });
        }
    });
    
    socket.on('disconnect', () => {
        console.log('Frontend disconnected');
    });
});

// API Routes
app.get('/api/clients', (req, res) => {
    const clientList = Array.from(clients.keys()).map(clientId => ({
        clientId: clientId,
        status: clientStatus.get(clientId) || 'disconnected',
        messageCount: (clientMessages.get(clientId) || []).length
    }));
    res.json(clientList);
});

app.get('/api/status/:clientId', (req, res) => {
    const { clientId } = req.params;
    const status = clientStatus.get(clientId) || 'disconnected';
    const messages = clientMessages.get(clientId) || [];
    res.json({ 
        clientId: clientId,
        status: status, 
        messageCount: messages.length 
    });
});

app.get('/api/messages/:clientId', (req, res) => {
    const { clientId } = req.params;
    const messages = clientMessages.get(clientId) || [];
    res.json(messages);
});

// Start the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Open http://localhost:${PORT} in your browser`);
    console.log('Multi-client WhatsApp bot ready!');
}); 