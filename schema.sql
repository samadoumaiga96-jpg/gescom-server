-- ==========================================================================
-- GESCOM — Schéma PostgreSQL du backend de synchronisation multi-appareils
-- (étape 2 de l'architecture cloud — voir le plan pour le contexte complet)
--
-- À exécuter une fois sur la base cible :
--   psql "$DATABASE_URL" -f schema.sql
-- ==========================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- pour gen_random_uuid()

-- Une organisation = une entreprise cliente de GESCOM. Toutes les données
-- d'une organisation sont strictement isolées des autres (voir routes/*.js :
-- chaque requête filtre par organization_id issu du token, jamais du client).
CREATE TABLE IF NOT EXISTS organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  -- Prépare les formules commerciales (point 17 du cahier des charges) sans
  -- implémenter toute la facturation : 'local' (pas de cloud), 'cloud'
  -- (PC + mobile), 'pro' (plusieurs appareils/utilisateurs). Le nombre
  -- d'appareils autorisés en découle (voir routes/auth.js).
  plan TEXT NOT NULL DEFAULT 'cloud',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Comptes cloud (identité "à qui appartiennent ces données"). Distinct du
-- système de rôles local de GESCOM (DB.utilisateurs, admin/gestionnaire/
-- caissier) qui continue de gérer les droits *sur un poste donné* et n'est
-- pas modifié par cette table.
CREATE TABLE IF NOT EXISTS accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT,
  role TEXT NOT NULL DEFAULT 'owner', -- owner | member (niveau compte cloud)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS accounts_org_idx ON accounts (organization_id);

-- Un appareil = une installation GESCOM (PC ou mobile) connectée à un compte.
-- Le refresh token n'est jamais stocké en clair.
CREATE TABLE IF NOT EXISTS devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  device_name TEXT,
  platform TEXT,       -- 'windows' | 'android' | 'web' | ...
  app_version TEXT,
  refresh_token_hash TEXT,
  refresh_token_expires_at TIMESTAMPTZ,
  last_sync TIMESTAMPTZ,
  last_seen TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS devices_org_idx ON devices (organization_id);
CREATE INDEX IF NOT EXISTS devices_account_idx ON devices (account_id);

-- Magasin générique des données synchronisées : une ligne par enregistrement
-- GESCOM (produit, client, document, mouvement de stock...), identifiée par
-- son uuid stable (pas par un id auto-incrémenté local). Le payload est le
-- JSON complet de l'enregistrement tel qu'envoyé par le client — GESCOM
-- reste vanilla JS sans schéma relationnel strict côté client, donc on ne
-- duplique pas une table SQL par entité métier : ça éviterait une migration
-- à chaque nouveau champ ajouté côté app (ce qui arrive souvent, cf. le
-- rythme d'évolution du schéma local cette session). Les rapports/calculs
-- métier restent côté client, comme aujourd'hui — ce serveur ne fait que
-- transporter les données entre appareils.
CREATE TABLE IF NOT EXISTS entities (
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id UUID NOT NULL,
  payload JSONB,
  updated_at TIMESTAMPTZ NOT NULL,
  deleted_at TIMESTAMPTZ,
  device_id UUID,
  PRIMARY KEY (organization_id, entity_type, entity_id)
);
CREATE INDEX IF NOT EXISTS entities_org_updated_idx ON entities (organization_id, updated_at);

-- Journal des opérations sensibles (connexions, inscriptions, révocations
-- d'appareil...) — pas les pushs/pulls de synchro un par un (trop volumineux,
-- peu utile pour un audit de sécurité). Conservé même si le compte/l'appareil
-- est supprimé ensuite (ON DELETE SET NULL), pour garder une trace.
CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL,
  account_id UUID REFERENCES accounts(id) ON DELETE SET NULL,
  device_id UUID REFERENCES devices(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  details JSONB,
  ip TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_log_org_idx ON audit_log (organization_id, created_at);

-- Migration idempotente : sur une base créée avant l'ajout de la colonne "plan"
-- (CREATE TABLE IF NOT EXISTS ne modifie pas une table déjà existante).
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS plan TEXT NOT NULL DEFAULT 'cloud';
