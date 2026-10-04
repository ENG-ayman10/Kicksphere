const deviceService = require('../services/notificationDeviceService');
const logger = require('../utils/logger');
const requireSelf = (req, res, next) => {
  if (!req.user?.id) return res.status(401).json({ success: false, message: 'Authentication required.' });
  if (String(req.user.id) !== req.params.userId) return res.status(403).json({ success: false, message: 'This installation belongs to another user.' });
  return next();
};
function handler(action) {
  return async (req, res) => {
    // Defense in depth for direct controller invocation and future route changes.
    if (!req.user?.id || String(req.user.id) !== req.params.userId) return requireSelf(req, res, () => {});
    try {
      const data = await action(req.params.userId, req.params.deviceId, req.body);
      return res.json({ success: true, data, ...(data.registered === true
        ? { automaticEventsEnabled: process.env.ENABLE_LIVE_POLLING === 'true' } : {}) });
    } catch (error) {
      const status = error.statusCode || 500;
      if (status >= 500) logger.warn('Notification installation operation failed.');
      return res.status(status).json({ success: false, message: status >= 500 ? 'Server Error' : error.message });
    }
  };
}
const testDevice = async (req, res) => {
  if (!req.user?.id || String(req.user.id) !== req.params.userId) return requireSelf(req, res, () => {});
  try {
    const data = await deviceService.testDevice(req.params.userId, req.params.deviceId);
    return res.status(data.sent ? 200 : 502).json({ success: data.sent, data,
      message: data.sent ? 'Test notification accepted for delivery.' : 'Test notification could not be sent.' });
  } catch (error) {
    const status = error.statusCode || 500;
    return res.status(status).json({ success: false, message: status >= 500 ? 'Server Error' : error.message });
  }
};
module.exports = { requireSelf, registerDevice: handler((userId, deviceId, body) => deviceService.register(userId, deviceId, body)),
  revokeDevice: handler(async (userId, deviceId) => ({ deviceId, revoked: await deviceService.revoke(userId, deviceId) })), testDevice };
