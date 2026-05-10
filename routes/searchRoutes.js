/**
 * @file searchRoutes.js
 * @description Routing for the Universal Search API.
 */

const express = require('express');
const router = express.Router();
const { search } = require('../controllers/searchController');

router.get('/', search);

module.exports = router;
