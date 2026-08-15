import { Pool } from 'pg';

let pool: Pool | null = null;

function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      host: process.env.DB_HOST ?? 'localhost',
      port: parseInt(process.env.DB_PORT ?? '5432', 10),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      connectionTimeoutMillis: 5000,
      ssl: false,
    });
  }
  return pool;
}

export async function getAllowedVehicleIds(groups: string[]): Promise<string[] | undefined> {
  // Fail CLOSED: without the vehicle-groups DB we can't authorize anyone, so
  // return [] (deny all) rather than undefined (which consumers treat as
  // allow-all). A misconfigured deployment must deny, never expose the fleet.
  if (!process.env.DB_NAME) return [];
  if (!groups.length) return [];
  const result = await getPool().query<{ vehicle_id: string }>(
    'SELECT DISTINCT vehicle_id FROM vehicle_groups WHERE group_name = ANY($1)',
    [groups],
  );
  return result.rows.map((r) => r.vehicle_id);
}
