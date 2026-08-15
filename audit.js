'use strict';
/* ==========================================================================
   GESCOM — Journalisation des opérations sensibles côté serveur (connexions,
   inscriptions, révocations d'appareil...). Best-effort : un échec d'écriture
   du journal ne doit jamais faire échouer la requête utilisateur elle-même.
   ========================================================================== */
const { query } = require('./db');

function logAudit(champs){
  const { organizationId, accountId, deviceId, action, details, ip } = champs || {};
  query(
    `INSERT INTO audit_log (organization_id, account_id, device_id, action, details, ip)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [organizationId||null, accountId||null, deviceId||null, action, details ? JSON.stringify(details) : null, ip||null]
  ).catch(e => console.error('Erreur journalisation audit (' + action + ') :', e.message));
}

module.exports = { logAudit };
