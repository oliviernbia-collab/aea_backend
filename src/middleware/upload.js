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

const MAX_FILE_BYTES = 20 * 1024 * 1024;

// Le WAF/edge de l'hebergeur (LWS) bloque sans distinction toute requete POST en
// multipart/form-data avant qu'elle n'atteigne l'app (403.4), que la route ait ou non
// un champ fichier. Les fichiers (image, PDF, video) voyagent donc en base64 dans le
// corps JSON (voir express.json({ limit }) dans app.js) plutot qu'en multipart.
const DATA_URI_RE = /^data:([\w/+.-]+);base64,([A-Za-z0-9+/=]+)$/;

function parseDataUri(value) {
  if (typeof value !== 'string') return null;
  const match = DATA_URI_RE.exec(value);
  if (!match) return null;
  return { mimetype: match[1], base64: match[2] };
}

// Conserve la meme API que l'ancien middleware base sur Multer (uploader.single(champ))
// pour ne pas avoir a modifier les routes : req.file = { path, filename, size, mimetype }.
function makeUploader(subfolder) {
  return {
    single(fieldName) {
      return async (req, res, next) => {
        const value = req.body?.[fieldName];
        if (value === undefined || value === null || value === '') return next();

        const parsed = parseDataUri(value);
        if (!parsed) {
          return res.status(400).json({ message: 'Fichier invalide.' });
        }
        if (!ALLOWED_MIME.has(parsed.mimetype)) {
          return res.status(400).json({ message: 'Type de fichier non autorisé (image, PDF ou vidéo uniquement).' });
        }
        const approxBytes = Math.ceil((parsed.base64.length * 3) / 4);
        if (approxBytes > MAX_FILE_BYTES) {
          return res.status(413).json({ message: 'Fichier trop volumineux (20 Mo max).' });
        }

        try {
          const result = await cloudinary.uploader.upload(value, {
            folder: `aea/${subfolder}`,
            resource_type: 'auto',
          });
          req.file = {
            path: result.secure_url,
            filename: result.public_id,
            size: result.bytes,
            mimetype: parsed.mimetype,
          };
          delete req.body[fieldName];
          next();
        } catch (err) {
          next(err);
        }
      };
    },
  };
}

module.exports = { makeUploader };
