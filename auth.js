'use strict';
/* ==========================================================================
   GESCOM — Utilitaires d'authentification cloud (comptes, appareils).
   Distinct du système de rôles local de l'app (admin/gestionnaire/caissier),
   qui reste géré côté client et n'est pas concerné par ce fichier.
   ========================================================================== */
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const JWT_SECRET = process.env.JWT_SECRET;
if(!JWT_SECRET){
  console.warn('ATTENTION : JWT_SECRET non défini. Utilisation d\'un secret de test non sécurisé.');
}
const SECRET = JWT_SECRET || 'dev-secret-a-changer-absolument';
const ACCESS_TOKEN_TTL = '15m';
const REFRESH_TOKEN_TTL_DAYS = 30;

function hashPassword(motDePasse){ return bcrypt.hash(motDePasse, 12); }
function verifyPassword(motDePasse, hash){ return bcrypt.compare(motDePasse, hash); }

function signAccessToken({ accountId, organizationId, deviceId }){
  return jwt.sign({ accountId, organizationId, deviceId }, SECRET, { expiresIn: ACCESS_TOKEN_TTL });
}
/* Le refresh token lui-même n'est jamais stocké : on stocke son hash (comme
   un mot de passe) et on compare au moment du /api/auth/refresh. */
function generateRefreshToken(){
  return crypto.randomBytes(48).toString('hex');
}
function hashRefreshToken(token){
  return crypto.createHash('sha256').update(token).digest('hex');
}
function refreshTokenExpiry(){
  const d = new Date();
  d.setDate(d.getDate() + REFRESH_TOKEN_TTL_DAYS);
  return d;
}

/* Middleware : vérifie le token d'accès (Authorization: Bearer <jwt>) et attache
   req.auth = {accountId, organizationId, deviceId}. Ne fait JAMAIS confiance à un
   organizationId fourni par le client (body/query) — toujours celui du token. */
function requireAuth(req, res, next){
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if(!token) return res.status(401).json({ error: 'Jeton manquant.' });
  try{
    const payload = jwt.verify(token, SECRET);
    req.auth = payload;
    next();
  }catch(e){
    return res.status(401).json({ error: 'Jeton invalide ou expiré.' });
  }
}

module.exports = {
  hashPassword, verifyPassword, signAccessToken,
  generateRefreshToken, hashRefreshToken, refreshTokenExpiry,
  requireAuth
};
