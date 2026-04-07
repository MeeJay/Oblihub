import './src/env';
import type { Knex } from 'knex';
import path from 'path';

const isCompiled = __filename.endsWith('.js');

const config: Knex.Config = {
  client: 'pg',
  connection: process.env.DATABASE_URL,
  migrations: {
    directory: isCompiled
      ? path.resolve(__dirname, 'src/db/migrations')   // dist/src/db/migrations (production)
      : path.resolve(__dirname, 'src/db/migrations'),  // src/db/migrations (dev with tsx)
    extension: isCompiled ? 'js' : 'ts',
  },
};

export default config;
