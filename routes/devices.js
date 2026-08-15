'use strict';
/* ==========================================================================
   GESCOM — Gestion des appareils ("Mes appareils"). Toutes les requêtes sont
   filtrées par l'organisation du token vérifié (req.auth), jamais par une
   valeur envoyée par le client.
   ========================================================================== */
const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../auth');
const { logAudit } = require('../audit');

const router = express.Router();
router.use(requireAuth);

/* ---- Liste des appareils de l'organisation ---- */
router.get('/', async (req, res) => {
  try{
    const result = await query(
      `SELECT id, device_name, platform, app_version, last_sync, last_seen, revoked_at, created_at
       FROM devices WHERE organization_id=$1 ORDER BY last_seen DESC NULLS LAST, created_at DESC`,
      [req.auth.organizationId]
    );
    res.json(result.rows);
  }catch(e){
    console.error('Erreur GET /api/devices :', e.message);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

/* ---- Révoquer un appareil (déconnexion forcée — il ne pourra plus rafraîchir son token) ---- */
router.patch('/:id/revoquer', async (req, res) => {
  try{
    const result = await query(
      `UPDATE devices SET revoked_at=now() WHERE id=$1 AND organization_id=$2 RETURNING id`,
      [req.params.id, req.auth.organizationId]
    );
    if(!result.rows.length) return res.status(404).json({ error: 'Appareil introuvable.' });
    logAudit({ organizationId: req.auth.organizationId, accountId: req.auth.accountId, deviceId: req.params.id, action:'device_revoked', details:{ revoquePar: req.auth.deviceId }, ip: req.ip });
    res.json({ ok: true });
  }catch(e){
    console.error('Erreur PATCH /api/devices/:id/revoquer :', e.message);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

module.exports = router;
