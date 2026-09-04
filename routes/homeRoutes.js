const express = require('express');
const router = express.Router();

const { getHome } = require('../controllers/homeController');
const { optionalAuth } = require('../middlewares/authMiddleware');

router.get('/', optionalAuth, getHome);

module.exports = router;
