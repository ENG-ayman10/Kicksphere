/**
 * @file emailService.js
 * @description Email sending service using Nodemailer.
 * Supports SMTP (Gmail, SendGrid, etc.) or safe dev fallback.
 */

const nodemailer = require('nodemailer');
const logger = require('../utils/logger');

const getTransporter = () => {
  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    return null;
  }

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass }
  });
};

exports.isConfigured = () => {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
};

exports.sendResetPasswordEmail = async (toEmail, code, userName = 'Fan') => {
  const transporter = getTransporter();

  // Log in server console for easy dev inspection
  logger.info(`🔑 [RESET PASSWORD OTP] Code for ${toEmail}: [ ${code} ]`);

  if (!transporter) {
    logger.warn(`⚠️ SMTP is not configured in .env. Email not sent, code is: ${code}`);
    return {
      sent: false,
      reason: 'SMTP_NOT_CONFIGURED',
      devCode: code
    };
  }

  const mailOptions = {
    from: process.env.SMTP_FROM || `"KickSphere" <${process.env.SMTP_USER}>`,
    to: toEmail,
    subject: `⚽ KickSphere — Password Reset Code: ${code}`,
    html: `
      <div style="font-family: Arial, sans-serif; background-color: #0A0F0D; color: #FFFFFF; padding: 30px; border-radius: 12px; max-width: 500px; margin: auto;">
        <div style="text-align: center; margin-bottom: 20px;">
          <h1 style="color: #00FF87; margin: 0; font-size: 28px; letter-spacing: -1px;">KickSphere</h1>
          <p style="color: #8E9B94; margin: 5px 0 0 0; font-size: 13px;">Live Football Universe</p>
        </div>
        <div style="background-color: #141E18; border: 1px solid #23352B; border-radius: 10px; padding: 25px; text-align: center;">
          <h2 style="color: #FFFFFF; margin-top: 0;">Password Reset Code</h2>
          <p style="color: #B0C4B8; font-size: 14px; line-height: 1.5;">
            Hello <strong>${userName}</strong>,<br>
            We received a request to reset your password. Use the verification code below to set a new password:
          </p>
          <div style="background: #00FF87; color: #000000; font-size: 32px; font-weight: 900; letter-spacing: 8px; padding: 14px; border-radius: 8px; margin: 25px 0; display: inline-block;">
            ${code}
          </div>
          <p style="color: #6C7F74; font-size: 12px; margin-bottom: 0;">
            This code will expire in <strong>15 minutes</strong>.<br>
            If you did not request this reset, you can safely ignore this email.
          </p>
        </div>
        <p style="color: #4C5D54; font-size: 11px; text-align: center; margin-top: 25px;">
          © ${new Date().getFullYear()} KickSphere. All rights reserved.
        </p>
      </div>
    `
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    logger.info(`📧 Password reset email sent to ${toEmail} (Message ID: ${info.messageId})`);
    return { sent: true, messageId: info.messageId };
  } catch (error) {
    logger.error(`❌ Failed to send password reset email to ${toEmail}: ${error.message}`);
    return { sent: false, reason: error.message, devCode: code };
  }
};
