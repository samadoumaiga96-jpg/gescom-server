'use strict';
/* ==========================================================================
   GESCOM — Routes d'authentification cloud : inscription, connexion,
   rafraîchissement de session. Chaque installation GESCOM (PC ou mobile)
   correspond à un "appareil" (device) rattaché à un compte cloud.
   ========================================================================== */
const express = require('express');
const { query, pool } = require('../db');
const {
  hashPassword, verifyPassword, signAccessToken,
  generateRefreshToken, hashRefreshToken, refreshTokenExpiry
} = require('../auth');
const { logAudit } = require('../audit');

const router = express.Router();

/* e.message est parfois vide (ex: AggregateError renvoyée par Node lors d'un échec de
   connexion réseau avec plusieurs adresses candidates — son message propre est souvent
   vide, le détail utile est dans .errors[]). On journalise tout ce qui peut aider à
   diagnostiquer plutôt que de se fier au seul .message. */
function decrireErreur(e){
  if(!e) return 'erreur inconnue';
  const parties = [e.name, e.code, e.message].filter(Boolean);
  if(Array.isArray(e.errors) && e.errors.length){
    parties.push('causes: ' + e.errors.map(sub => (sub && (sub.code || sub.message)) || String(sub)).join(', '));
  }
  return parties.length ? parties.join(' | ') : (e.stack || String(e));
}
function emailValide(email){ return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email||'')); }
/* Nombre d'appareils autorisés selon la formule (point 17 du cahier des charges —
   architecture prête, sans facturation complète pour l'instant). */
const LIMITE_APPAREILS_PAR_PLAN = { local: 1, cloud: 2, pro: 10 };
function limiteAppareilsPourPlan(plan){ return LIMITE_APPAREILS_PAR_PLAN[plan] || LIMITE_APPAREILS_PAR_PLAN.cloud; }

/* ---- Inscription : crée l'organisation, le premier compte (owner) et son appareil ---- */
router.post('/register', async (req, res) => {
  const { organizationName, email, password, deviceName, platform, appVersion } = req.body || {};
  if(!organizationName || !String(organizationName).trim()){
    return res.status(400).json({ error: "Le nom de l'entreprise est obligatoire." });
  }
  if(!emailValide(email)){
    return res.status(400).json({ error: 'Adresse email invalide.' });
  }
  if(!password || String(password).length < 8){
    return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 8 caractères.' });
  }
  const emailNorm = String(email).trim().toLowerCase();

  let client;
  try{
    client = await pool.connect();
    await client.query('BEGIN');
    const existant = await client.query('SELECT id FROM accounts WHERE email=$1', [emailNorm]);
    if(existant.rows.length){
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Cet email est déjà utilisé.' });
    }
    const org = await client.query(
      'INSERT INTO organizations (name) VALUES ($1) RETURNING id, name',
      [String(organizationName).trim()]
    );
    const passwordHash = await hashPassword(String(password));
    const account = await client.query(
      `INSERT INTO accounts (organization_id, email, password_hash, name, role)
       VALUES ($1,$2,$3,$4,'owner') RETURNING id, email, name, role`,
      [org.rows[0].id, emailNorm, passwordHash, (req.body.name||'').trim() || null]
    );
    const refreshToken = generateRefreshToken();
    const device = await client.query(
      `INSERT INTO devices (organization_id, account_id, device_name, platform, app_version, refresh_token_hash, refresh_token_expires_at, last_seen)
       VALUES ($1,$2,$3,$4,$5,$6,$7, now()) RETURNING id, device_name, platform`,
      [org.rows[0].id, account.rows[0].id, deviceName||null, platform||null, appVersion||null, hashRefreshToken(refreshToken), refreshTokenExpiry()]
    );
    await client.query('COMMIT');

    logAudit({ organizationId: org.rows[0].id, accountId: account.rows[0].id, deviceId: device.rows[0].id, action:'register', details:{ email: emailNorm }, ip: req.ip });
    const accessToken = signAccessToken({ accountId: account.rows[0].id, organizationId: org.rows[0].id, deviceId: device.rows[0].id });
    res.json({
      accessToken, refreshToken,
      organization: org.rows[0], account: account.rows[0], device: device.rows[0]
    });
  }catch(e){
    if(client){ try{ await client.query('ROLLBACK'); }catch(e2){} }
    console.error('Erreur /api/auth/register :', decrireErreur(e));
    res.status(500).json({ error: 'Erreur serveur lors de l\'inscription.' });
  }finally{
    if(client) client.release();
  }
});

/* ---- Connexion : vérifie le mot de passe, réutilise ou crée un appareil ---- */
router.post('/login', async (req, res) => {
  const { email, password, deviceId, deviceName, platform, appVersion } = req.body || {};
  if(!emailValide(email) || !password){
    return res.status(400).json({ error: 'Email et mot de passe requis.' });
  }
  const emailNorm = String(email).trim().toLowerCase();
  try{
    const result = await query('SELECT * FROM accounts WHERE email=$1', [emailNorm]);
    const account = result.rows[0];
    if(!account || !(await verifyPassword(String(password), account.password_hash))){
      logAudit({ organizationId: account&&account.organization_id, accountId: account&&account.id, action:'login_failed', details:{ email: emailNorm }, ip: req.ip });
      return res.status(401).json({ error: 'Email ou mot de passe incorrect.' });
    }

    const refreshToken = generateRefreshToken();
    let device;
    if(deviceId){
      const existant = await query(
        'SELECT * FROM devices WHERE id=$1 AND account_id=$2 AND revoked_at IS NULL',
        [deviceId, account.id]
      );
      if(!existant.rows.length){
        return res.status(404).json({ error: 'Appareil introuvable ou révoqué. Reconnectez-vous sans deviceId pour en créer un nouveau.' });
      }
      const maj = await query(
        `UPDATE devices SET refresh_token_hash=$1, refresh_token_expires_at=$2, last_seen=now(),
         device_name=COALESCE($3, device_name), platform=COALESCE($4, platform), app_version=COALESCE($5, app_version)
         WHERE id=$6 RETURNING id, device_name, platform`,
        [hashRefreshToken(refreshToken), refreshTokenExpiry(), deviceName||null, platform||null, appVersion||null, deviceId]
      );
      device = maj.rows[0];
    } else {
      const org = await query('SELECT plan FROM organizations WHERE id=$1', [account.organization_id]);
      const limite = limiteAppareilsPourPlan(org.rows[0] && org.rows[0].plan);
      const actifs = await query('SELECT count(*)::int AS n FROM devices WHERE organization_id=$1 AND revoked_at IS NULL', [account.organization_id]);
      if(actifs.rows[0].n >= limite){
        return res.status(403).json({ error: 'Limite d\'appareils atteinte pour votre formule ('+limite+'). Révoquez un appareil existant avant d\'en connecter un nouveau.' });
      }
      const cree = await query(
        `INSERT INTO devices (organization_id, account_id, device_name, platform, app_version, refresh_token_hash, refresh_token_expires_at, last_seen)
         VALUES ($1,$2,$3,$4,$5,$6,$7, now()) RETURNING id, device_name, platform`,
        [account.organization_id, account.id, deviceName||null, platform||null, appVersion||null, hashRefreshToken(refreshToken), refreshTokenExpiry()]
      );
      device = cree.rows[0];
    }

    logAudit({ organizationId: account.organization_id, accountId: account.id, deviceId: device.id, action:'login', details:{ email: emailNorm, nouvelAppareil: !deviceId }, ip: req.ip });
    const accessToken = signAccessToken({ accountId: account.id, organizationId: account.organization_id, deviceId: device.id });
    res.json({
      accessToken, refreshToken,
      account: { id: account.id, email: account.email, name: account.name, role: account.role },
      organizationId: account.organization_id,
      device
    });
  }catch(e){
    console.error('Erreur /api/auth/login :', decrireErreur(e));
    res.status(500).json({ error: 'Erreur serveur lors de la connexion.' });
  }
});

/* ---- Rafraîchissement : échange un refresh token valide contre un nouvel access token ---- */
router.post('/refresh', async (req, res) => {
  const { deviceId, refreshToken } = req.body || {};
  if(!deviceId || !refreshToken) return res.status(400).json({ error: 'deviceId et refreshToken requis.' });
  try{
    const result = await query('SELECT * FROM devices WHERE id=$1 AND revoked_at IS NULL', [deviceId]);
    const device = result.rows[0];
    if(!device || device.refresh_token_hash !== hashRefreshToken(refreshToken)){
      return res.status(401).json({ error: 'Session invalide, reconnectez-vous.' });
    }
    if(!device.refresh_token_expires_at || new Date(device.refresh_token_expires_at) < new Date()){
      return res.status(401).json({ error: 'Session expirée, reconnectez-vous.' });
    }
    await query('UPDATE devices SET last_seen=now() WHERE id=$1', [deviceId]);
    const accessToken = signAccessToken({ accountId: device.account_id, organizationId: device.organization_id, deviceId: device.id });
    res.json({ accessToken });
  }catch(e){
    console.error('Erreur /api/auth/refresh :', decrireErreur(e));
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

module.exports = router;
