const db = require('../config/firebase');
const logger = require('../utils/logger');
const { normalizeRoomValue } = require('../utils/socketRooms');

exports.sendMessage = async (req, res) => {
    try {
        const { matchId } = req.params;
        const { text } = req.body;
        const safeMatchId = normalizeRoomValue(matchId);

        if (!safeMatchId) return res.status(400).json({ success: false, message: "Invalid match id" });
        if (!text) return res.status(400).json({ success: false, message: "Missing fields" });
        if (typeof text !== 'string' || text.trim().length === 0 || text.length > 500) {
            return res.status(400).json({ success: false, message: "Message must be between 1 and 500 characters" });
        }

        const displayName = req.user.name || req.user.email || req.user.id;

        const newMessage = {
            userId: req.user.id,
            username: String(displayName).slice(0, 80),
            text: text.trim(),
            timestamp: new Date()
        };

        const docRef = await db.collection('chat_rooms').doc(safeMatchId).collection('messages').add(newMessage);
        newMessage.id = docRef.id;

        // Broadcast to WebSocket room
        const io = req.app.get('io');
        if (io) {
            const { matchRoom } = require('../utils/socketRooms');
            io.to(matchRoom(safeMatchId)).emit('newMessage', {
                ...newMessage,
                user: newMessage.username,
                message: newMessage.text
            });
        }

        res.status(201).json({ success: true, data: newMessage });
    } catch (error) {
        logger.error(`Chat send error: ${error.message}`);
        res.status(500).json({ success: false, message: "Server Error" });
    }
};

exports.getMatchMessages = async (req, res) => {
    try {
        const { matchId } = req.params;
        const safeMatchId = normalizeRoomValue(matchId);
        if (!safeMatchId) return res.status(400).json({ success: false, message: "Invalid match id" });

        const snapshot = await db.collection('chat_rooms').doc(safeMatchId).collection('messages').orderBy('timestamp', 'asc').limit(50).get();
        
        const messages = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        res.status(200).json({ success: true, data: messages });
    } catch (error) {
        logger.error(`Chat fetch error: ${error.message}`);
        res.status(500).json({ success: false, message: "Server Error" });
    }
};
