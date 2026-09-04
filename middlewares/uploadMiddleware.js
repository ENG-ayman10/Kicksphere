const multer = require('multer');
const path = require('path');
const fs = require('fs');

const allowedImageTypes = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif'
};

const sanitizeFileSegment = (value) => {
  return String(value || 'avatar')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 80);
};

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '../uploads/avatars');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const preferredExt = allowedImageTypes[file.mimetype];
    const originalExt = path.extname(file.originalname).toLowerCase();
    const ext = originalExt && Object.values(allowedImageTypes).includes(originalExt)
      ? originalExt
      : preferredExt;
    const userId = sanitizeFileSegment(req.params.userId);

    cb(null, `${userId}-${Date.now()}${ext}`);
  }
});

const fileFilter = (req, file, cb) => {
  if (allowedImageTypes[file.mimetype]) {
    cb(null, true);
  } else {
    cb(new Error('Only JPEG, PNG, WebP, and GIF images are allowed!'), false);
  }
};

const upload = multer({ 
  storage, 
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB max
});

module.exports = upload;
