import mysql from 'mysql2/promise';

export interface DatabaseHealthCheck {
  checkHealth(): Promise<void>;
}

/**
 * Builds a connection pool once (not one connection per health check -- a
 * pool amortizes the TCP+auth handshake and caps how many concurrent
 * connections this process can open against MySQL) and returns a
 * `checkHealth` that reuses it. `mysql2` accepts the connection URI
 * directly, so no manual parsing of `databaseUrl` is needed.
 */
export function createDatabaseHealthCheck(databaseUrl: string): DatabaseHealthCheck {
  const pool = mysql.createPool(databaseUrl);

  return {
    async checkHealth(): Promise<void> {
      await pool.query('SELECT 1');
    },
  };
}
