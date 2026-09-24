import postgres from 'postgres';

const mod = await import('./env.local.js');
const k = mod.TEST_KEYS;

if (!k.DATABASE_URL || k.DATABASE_URL.includes('TU_PASSWORD') || k.DATABASE_URL.includes('[YOUR-PASSWORD]')) {
  console.error('❌ DATABASE_URL no está configurada o tiene el placeholder sin reemplazar');
  process.exit(1);
}

try {
  const sql = postgres(k.DATABASE_URL, { max: 1, prepare: false });
  const [r] = await sql`select 1 as ok`;
  console.log('✅ Conexión OK. Resultado:', r.ok);
  await sql.end();
  process.exit(0);
} catch (e) {
  console.error('❌ Error:', e.message);
  process.exit(1);
}