const multer = require('multer');
const cloudinary = require('../config/cloudinary');

const ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
  'video/mp4',
  'video/quicktime',
  'video/webm',
]);

// Moteur de stockage Multer qui envoie directement le fichier (image, PDF ou video) vers
// Cloudinary en streaming, sans jamais l'ecrire sur le disque du serveur.
class CloudinaryStorage {
  constructor(folder) {
    this.folder = folder;
  }

  _handleFile(req, file, cb) {
    const uploadStream = cloudinary.uploader.upload_stream(
      { folder: `aea/${this.folder}`, resource_type: 'auto' },
      (err, result) => {
        if (err) return cb(err);
        cb(null, {
          path: result.secure_url,
          filename: result.public_id,
          size: result.bytes,
          mimetype: file.mimetype,
        });
      }
    );
    file.stream.pipe(uploadStream);
  }

  _removeFile(req, file, cb) {
    cloudinary.uploader.destroy(file.filename, { resource_type: 'auto' }, (err) => cb(err));
  }
}

function makeUploader(subfolder) {
  return multer({
    storage: new CloudinaryStorage(subfolder),
    limits: { fileSize: 20 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      if (!ALLOWED_MIME.has(file.mimetype)) {
        return cb(new Error('Type de fichier non autorise (image, PDF ou video uniquement).'));
      }
      cb(null, true);
    },
  });
}

module.exports = { makeUploader };
