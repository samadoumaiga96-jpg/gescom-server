'use strict';
const { Pool } = require('pg');

if(!process.env.DATABASE_URL){
  console.warn('ATTENTION : DATABASE_URL non définie. Le serveur de synchronisation ne pourra pas démarrer.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false }
});
/* pg émet 'error' sur le pool quand une connexion inactive tombe en erreur en
   arrière-plan ; sans ce listener, Node considère l'événement non géré et
   fait planter tout le processus (donc aussi le serveur de licences séparé
   qui tourne dans le même processus). */
pool.on('error', (err) => {
  console.error('Erreur inattendue sur une connexion PostgreSQL inactive :', err && (err.message || err.code || err.name) || err);
});

function query(text, params){
  return pool.query(text, params);
}

module.exports = { pool, query };
