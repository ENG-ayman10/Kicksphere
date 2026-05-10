const db = require('../config/firebase');

exports.sendMessage = async (req, res) => {
    try {
        const { matchId } = req.params;
        const { userId, username, text } = req.body;

        if (!text || !username) return res.status(400).json({ success: false, message: "Missing fields" });

        const newMessage = { userId: userId || 'guest', username, text, timestamp: new Date() };

        await db.collection('chat_rooms').doc(matchId).collection('messages').add(newMessage);

        res.status(201).json({ success: true, data: newMessage });
    } catch (error) {
        res.status(500).json({ success: false, message: "Chat Error", error: error.message });
    }
};

exports.getMatchMessages = async (req, res) => {
    try {
        const { matchId } = req.params;
        const snapshot = await db.collection('chat_rooms').doc(matchId).collection('messages').orderBy('timestamp', 'asc').limit(50).get();
        
        const messages = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        res.status(200).json({ success: true, data: messages });
    } catch (error) {
        res.status(500).json({ success: false, message: "Chat Error", error: error.message });
    }
};