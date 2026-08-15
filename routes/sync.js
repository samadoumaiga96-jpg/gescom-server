'use strict';
/* ==========================================================================
   GESCOM — Synchronisation : le client pousse sa file d'opérations locales
   (DB.syncQueue, voir assets/js/data.js) puis récupère ce qui a changé côté
   serveur depuis sa dernière synchro. Protocole REST simple (pas de temps
   réel) — voir le plan d'architecture pour la justification.

   Résolution de conflit : "dernier écrit gagne" par updated_at, appliqué de
   façon atomique en SQL (INSERT ... ON CONFLICT ... WHERE entities.updated_at
   <= EXCLUDED.updated_at) pour rester correct même avec des pushs concurrents.
   ========================================================================== */
const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();
router.use(requireAuth);

/* ---- Le client envoie le contenu de sa file locale (DB.syncQueue) ---- */
router.post('/push', async (req, res) => {
  const { operations } = req.body || {};
  if(!Array.isArray(operations)) return res.status(400).json({ error: 'operations doit être un tableau.' });
  if(operations.length > 500) return res.status(400).json({ error: 'Trop d\'opérations en une seule fois (max 500).' });

  const orgId = req.auth.organizationId;
  const deviceId = req.auth.deviceId;
  const results = [];

  for(const op of operations){
    if(!op || !op.entityType || !op.entityId || !op.operation){
      results.push({ id: op && op.id, status: 'REJECTED', error: 'Opération invalide (champs manquants).' });
      continue;
    }
    const estSuppression = op.operation === 'DELETE';
    const updatedAt = estSuppression
      ? (op.createdAt || new Date().toISOString())
      : ((op.payload && op.payload.updatedAt) || new Date().toISOString());
    try{
      const r = await query(
        `INSERT INTO entities (organization_id, entity_type, entity_id, payload, updated_at, deleted_at, device_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (organization_id, entity_type, entity_id)
         DO UPDATE SET payload=EXCLUDED.payload, updated_at=EXCLUDED.updated_at,
                        deleted_at=EXCLUDED.deleted_at, device_id=EXCLUDED.device_id
         WHERE entities.updated_at <= EXCLUDED.updated_at
         RETURNING entity_id`,
        [orgId, op.entityType, op.entityId, estSuppression ? null : op.payload, updatedAt, estSuppression ? updatedAt : null, deviceId]
      );
      /* rowCount à 0 : la clause WHERE a bloqué l'écriture — une version plus récente
         existe déjà côté serveur (conflit LWW). Ce n'est pas une erreur technique : le
         client doit savoir que SON changement n'a pas gagné, pour ne pas croire à tort
         qu'il est parti (voir sync.js côté client, DB.syncConflits). */
      results.push({ id: op.id, status: r.rowCount>0 ? 'APPLIED' : 'REJECTED_STALE' });
    }catch(e){
      console.error('Erreur push entité', op.entityType, op.entityId, ':', e.message);
      results.push({ id: op.id, status: 'REJECTED', error: 'Erreur serveur.' });
    }
  }

  try{ await query('UPDATE devices SET last_sync=now() WHERE id=$1', [deviceId]); }catch(e){}
  res.json({ results });
});

/* ---- Le client récupère tout ce qui a changé côté serveur depuis sa dernière
   synchro (paramètre since=ISO8601). On exclut les changements provenant du
   même appareil pour ne pas les lui renvoyer en écho. ---- */
router.get('/pull', async (req, res) => {
  const orgId = req.auth.organizationId;
  const deviceId = req.auth.deviceId;
  const since = req.query.since || '1970-01-01T00:00:00.000Z';
  try{
    const result = await query(
      `SELECT entity_type, entity_id, payload, updated_at, deleted_at
       FROM entities
       WHERE organization_id=$1 AND updated_at > $2 AND device_id IS DISTINCT FROM $3
       ORDER BY updated_at ASC
       LIMIT 2000`,
      [orgId, since, deviceId]
    );
    try{ await query('UPDATE devices SET last_sync=now() WHERE id=$1', [deviceId]); }catch(e){}
    res.json({ changes: result.rows, serverTime: new Date().toISOString() });
  }catch(e){
    console.error('Erreur GET /api/sync/pull :', e.message);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

module.exports = router;
