'use strict';
/* ==========================================================================
   GESCOM — Serveur de validation de licences
   À déployer sur un hébergement Node (Render, Railway, VPS, etc.). Les
   applications GESCOM installées chez vos clients appellent ce serveur pour
   vérifier leur licence ; si le serveur est injoignable, le client retombe
   sur sa dernière vérification connue (voir assets/js/licence.js).
   ========================================================================== */
try{ require('dotenv').config(); }catch(e){}

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const rateLimit = require('express-rate-limit');

const PORT = process.env.PORT || 4000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const DB_FILE = path.join(__dirname, 'licences.json');

if(!ADMIN_TOKEN){
  console.warn('ATTENTION : variable d\'environnement ADMIN_TOKEN non définie. Utilisation d\'un jeton de test non sécurisé.');
}
const TOKEN = ADMIN_TOKEN || 'dev-token-a-changer';

function lireDB(){
  try{ return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch(e){ return { licences: [] }; }
}
function ecrireDB(db){ fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }
function todayISO(){ return new Date().toISOString().slice(0,10); }
function genererCle(){
  const a = crypto.randomBytes(4).toString('hex').toUpperCase();
  const b = crypto.randomBytes(4).toString('hex').toUpperCase();
  return 'GSC-'+a+'-'+b;
}

const app = express();
app.use(cors());
/* Limite par défaut d'Express (100kb) trop basse pour le profil entreprise (logo, image de
   connexion, cachet, signature en base64 peuvent atteindre plusieurs Mo au total). */
app.use(express.json({ limit: '10mb' }));

function requireAdmin(req, res, next){
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if(token !== TOKEN) return res.status(401).json({error:'Non autorisé.'});
  next();
}

/* ---- Synchronisation multi-appareils (étape 2 de l'architecture cloud) ----
   Routes séparées des licences ci-dessus, ne nécessitent DATABASE_URL/JWT_SECRET
   que si utilisées. Un rate limit strict protège /api/auth/* contre le
   bourrinage de mots de passe ; un rate limit plus large couvre /api/sync/* et
   /api/devices/* (déjà protégées par jeton, mais on évite qu'un appareil buggé
   en boucle de synchro ne submerge le serveur). */
const authLimiter = rateLimit({ windowMs: 15*60*1000, max: 30, standardHeaders: true, legacyHeaders: false });
const syncLimiter = rateLimit({ windowMs: 5*60*1000, max: 120, standardHeaders: true, legacyHeaders: false });
app.use('/api/auth', authLimiter, require('./routes/auth'));
app.use('/api/devices', syncLimiter, require('./routes/devices'));
app.use('/api/sync', syncLimiter, require('./routes/sync'));

app.get('/', (req, res) => {
  res.json({ ok: true, service: 'gescom-licence-server' });
});

/* ---- Création d'une licence (admin) ---- */
app.post('/api/licences', requireAdmin, (req, res) => {
  const { titulaire, dureeJours } = req.body || {};
  if(!titulaire || !String(titulaire).trim()){
    return res.status(400).json({error:'Le titulaire est obligatoire.'});
  }
  let dateExpiration = null;
  if(dureeJours != null && dureeJours !== '' && dureeJours !== 'illimite'){
    const d = new Date();
    d.setDate(d.getDate() + parseInt(dureeJours, 10));
    dateExpiration = d.toISOString().slice(0,10);
  }
  const licence = {
    cle: genererCle(),
    titulaire: String(titulaire).trim(),
    dateEmission: todayISO(),
    dateExpiration,
    statut: 'active',
    derniereVerification: null
  };
  const db = lireDB();
  db.licences.unshift(licence);
  ecrireDB(db);
  res.json(licence);
});

/* ---- Liste des licences (admin) ---- */
app.get('/api/licences', requireAdmin, (req, res) => {
  const db = lireDB();
  res.json(db.licences);
});

/* ---- Révocation (admin) ---- */
app.patch('/api/licences/:cle/revoquer', requireAdmin, (req, res) => {
  const db = lireDB();
  const lic = db.licences.find(l => l.cle === req.params.cle);
  if(!lic) return res.status(404).json({error:'Licence introuvable.'});
  lic.statut = 'revoquee';
  ecrireDB(db);
  res.json(lic);
});

/* ---- Réactivation (admin) ---- */
app.patch('/api/licences/:cle/reactiver', requireAdmin, (req, res) => {
  const db = lireDB();
  const lic = db.licences.find(l => l.cle === req.params.cle);
  if(!lic) return res.status(404).json({error:'Licence introuvable.'});
  lic.statut = 'active';
  ecrireDB(db);
  res.json(lic);
});

/* ---- Vérification (public — appelé par les postes clients) ---- */
app.post('/api/licences/valider', (req, res) => {
  const { cle } = req.body || {};
  if(!cle) return res.status(400).json({valide:false, message:'Clé manquante.'});
  const db = lireDB();
  const lic = db.licences.find(l => l.cle === String(cle).trim());
  if(!lic) return res.json({valide:false, message:'Clé de licence inconnue.'});
  lic.derniereVerification = new Date().toISOString();
  ecrireDB(db);
  if(lic.statut === 'revoquee'){
    return res.json({valide:false, message:'Cette licence a été révoquée.', titulaire:lic.titulaire});
  }
  if(lic.dateExpiration && lic.dateExpiration < todayISO()){
    return res.json({valide:false, message:'Cette licence a expiré.', titulaire:lic.titulaire, dateExpiration:lic.dateExpiration});
  }
  res.json({valide:true, titulaire:lic.titulaire, dateEmission:lic.dateEmission, dateExpiration:lic.dateExpiration});
});

app.listen(PORT, () => {
  console.log('Serveur de licences GESCOM démarré sur le port '+PORT);
});
