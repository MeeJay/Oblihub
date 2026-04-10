import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Custom error pages
  await knex.schema.createTable('custom_pages', (t) => {
    t.increments('id').primary();
    t.string('name', 128).notNullable();
    t.text('description').nullable();
    t.jsonb('error_codes').notNullable(); // [404] or [500, 502, 503, 504]
    t.text('html_content').notNullable();
    t.string('theme', 30).notNullable().defaultTo('custom');
    t.boolean('is_builtin').notNullable().defaultTo(false);
    t.timestamps(true, true);
  });

  // Extended proxy host options
  await knex.schema.alterTable('proxy_hosts', (t) => {
    t.string('client_max_body_size', 20).nullable();
    t.integer('proxy_connect_timeout').nullable();
    t.integer('proxy_send_timeout').nullable();
    t.integer('proxy_read_timeout').nullable();
    t.boolean('proxy_buffering').nullable();
    t.integer('rate_limit_rps').nullable();
    t.integer('rate_limit_burst').nullable();
    t.boolean('gzip_enabled').notNullable().defaultTo(false);
    t.boolean('cors_enabled').notNullable().defaultTo(false);
    t.jsonb('custom_response_headers').nullable();
    t.integer('error_page_id').nullable().references('id').inTable('custom_pages').onDelete('SET NULL');
  });

  // Seed built-in error pages
  await knex('custom_pages').insert([
    {
      name: 'Navy Dark - 404',
      description: 'Dark navy theme 404 page with animations',
      error_codes: JSON.stringify([404]),
      theme: 'navy-dark',
      is_builtin: true,
      html_content: `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>404 – Page Not Found</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;600;700&family=DM+Mono&display=swap');
  *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
  :root { --navy-deep: #0a0f1e; --blue: #4a9eff; --muted: #6b7fa3; }
  html, body { height: 100%; background: var(--navy-deep); color: #fff; font-family: 'DM Sans', sans-serif; overflow: hidden; }
  body::before { content: ''; position: fixed; inset: 0; background-image: linear-gradient(rgba(74,158,255,0.04) 1px, transparent 1px), linear-gradient(90deg, rgba(74,158,255,0.04) 1px, transparent 1px); background-size: 40px 40px; pointer-events: none; }
  body::after { content: ''; position: fixed; width: 500px; height: 500px; bottom: -150px; left: -150px; background: radial-gradient(circle, rgba(74,158,255,0.12) 0%, transparent 70%); pointer-events: none; }
  .page { height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; position: relative; z-index: 1; padding: 40px; }
  .error-code { font-size: clamp(100px, 18vw, 140px); font-weight: 700; line-height: 1; letter-spacing: -6px; background: linear-gradient(135deg, #ffffff 20%, rgba(74,158,255,0.6) 80%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; opacity: 0; animation: fadeUp 0.6s 0.15s ease forwards; }
  .sep { width: 48px; height: 2px; background: linear-gradient(90deg, transparent, var(--blue), transparent); margin: 20px auto; opacity: 0; animation: fadeUp 0.6s 0.25s ease forwards; }
  .error-title { font-size: 20px; font-weight: 600; color: #e0e8ff; margin-bottom: 12px; opacity: 0; animation: fadeUp 0.6s 0.3s ease forwards; }
  .error-msg { font-size: 14px; color: var(--muted); line-height: 1.8; text-align: center; max-width: 400px; margin-bottom: 36px; opacity: 0; animation: fadeUp 0.6s 0.38s ease forwards; }
  .btn { display: inline-flex; align-items: center; gap: 8px; padding: 12px 28px; background: linear-gradient(135deg, #1a4a8a, #0d2a5c); border: 1px solid rgba(74,158,255,0.3); border-radius: 6px; color: var(--blue); font-family: 'DM Sans', sans-serif; font-size: 13px; font-weight: 600; text-decoration: none; cursor: pointer; transition: all 0.25s; opacity: 0; animation: fadeUp 0.6s 0.45s ease forwards; }
  .btn:hover { background: linear-gradient(135deg, #2a5aaa, #1d3a7a); border-color: rgba(74,158,255,0.6); }
  @keyframes fadeUp { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
</style>
</head>
<body>
<div class="page">
  <div class="error-code">404</div>
  <div class="sep"></div>
  <div class="error-title">Page Not Found</div>
  <div class="error-msg">The page you're looking for doesn't exist or has been moved.</div>
  <a class="btn" href="/">Back to Home</a>
</div>
</body>
</html>`,
    },
    {
      name: 'Navy Dark - 403',
      description: 'Dark navy theme 403 forbidden page',
      error_codes: JSON.stringify([403]),
      theme: 'navy-dark',
      is_builtin: true,
      html_content: `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>403 – Access Denied</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;600;700&family=DM+Mono&display=swap');
  *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
  :root { --navy-deep: #0a0f1e; --blue: #4a9eff; --muted: #6b7fa3; }
  html, body { height: 100%; background: var(--navy-deep); color: #fff; font-family: 'DM Sans', sans-serif; overflow: hidden; }
  body::before { content: ''; position: fixed; inset: 0; background-image: linear-gradient(rgba(74,158,255,0.04) 1px, transparent 1px), linear-gradient(90deg, rgba(74,158,255,0.04) 1px, transparent 1px); background-size: 40px 40px; pointer-events: none; }
  body::after { content: ''; position: fixed; width: 500px; height: 500px; top: -150px; right: -150px; background: radial-gradient(circle, rgba(255,74,74,0.15) 0%, transparent 70%); pointer-events: none; }
  .page { height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; position: relative; z-index: 1; padding: 40px; }
  .error-code { font-size: clamp(100px, 18vw, 140px); font-weight: 700; line-height: 1; letter-spacing: -6px; background: linear-gradient(135deg, #ffffff 20%, rgba(74,158,255,0.6) 80%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; opacity: 0; animation: fadeUp 0.6s 0.15s ease forwards; }
  .sep { width: 48px; height: 2px; background: linear-gradient(90deg, transparent, var(--blue), transparent); margin: 20px auto; opacity: 0; animation: fadeUp 0.6s 0.25s ease forwards; }
  .error-title { font-size: 20px; font-weight: 600; color: #e0e8ff; margin-bottom: 12px; opacity: 0; animation: fadeUp 0.6s 0.3s ease forwards; }
  .error-msg { font-size: 14px; color: var(--muted); line-height: 1.8; text-align: center; max-width: 400px; margin-bottom: 36px; opacity: 0; animation: fadeUp 0.6s 0.38s ease forwards; }
  .btn { display: inline-flex; align-items: center; gap: 8px; padding: 12px 28px; background: linear-gradient(135deg, #1a4a8a, #0d2a5c); border: 1px solid rgba(74,158,255,0.3); border-radius: 6px; color: var(--blue); font-family: 'DM Sans', sans-serif; font-size: 13px; font-weight: 600; text-decoration: none; cursor: pointer; transition: all 0.25s; opacity: 0; animation: fadeUp 0.6s 0.45s ease forwards; }
  .btn:hover { background: linear-gradient(135deg, #2a5aaa, #1d3a7a); border-color: rgba(74,158,255,0.6); }
  @keyframes fadeUp { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
</style>
</head>
<body>
<div class="page">
  <div class="error-code">403</div>
  <div class="sep"></div>
  <div class="error-title">Access Denied</div>
  <div class="error-msg">You don't have permission to access this resource.</div>
  <a class="btn" href="/">Back to Home</a>
</div>
</body>
</html>`,
    },
    {
      name: 'Navy Dark - 50x',
      description: 'Dark navy theme for server errors (500, 502, 503, 504)',
      error_codes: JSON.stringify([500, 502, 503, 504]),
      theme: 'navy-dark',
      is_builtin: true,
      html_content: `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Server Error</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;600;700&family=DM+Mono&display=swap');
  *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
  :root { --navy-deep: #0a0f1e; --blue: #4a9eff; --muted: #6b7fa3; }
  html, body { height: 100%; background: var(--navy-deep); color: #fff; font-family: 'DM Sans', sans-serif; overflow: hidden; }
  body::before { content: ''; position: fixed; inset: 0; background-image: linear-gradient(rgba(74,158,255,0.04) 1px, transparent 1px), linear-gradient(90deg, rgba(74,158,255,0.04) 1px, transparent 1px); background-size: 40px 40px; pointer-events: none; }
  body::after { content: ''; position: fixed; width: 600px; height: 600px; top: 50%; left: 50%; transform: translate(-50%,-50%); background: radial-gradient(circle, rgba(74,158,255,0.06) 0%, transparent 65%); pointer-events: none; }
  .page { height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; position: relative; z-index: 1; padding: 40px; }
  .error-code { font-size: clamp(100px, 18vw, 140px); font-weight: 700; line-height: 1; letter-spacing: -6px; background: linear-gradient(135deg, #ffffff 20%, rgba(74,158,255,0.6) 80%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; opacity: 0; animation: fadeUp 0.6s 0.15s ease forwards; }
  .sep { width: 48px; height: 2px; background: linear-gradient(90deg, transparent, var(--blue), transparent); margin: 20px auto; opacity: 0; animation: fadeUp 0.6s 0.25s ease forwards; }
  .error-title { font-size: 20px; font-weight: 600; color: #e0e8ff; margin-bottom: 12px; opacity: 0; animation: fadeUp 0.6s 0.3s ease forwards; }
  .error-msg { font-size: 14px; color: var(--muted); line-height: 1.8; text-align: center; max-width: 420px; margin-bottom: 36px; opacity: 0; animation: fadeUp 0.6s 0.38s ease forwards; }
  .actions { display: flex; gap: 12px; opacity: 0; animation: fadeUp 0.6s 0.45s ease forwards; }
  .btn { display: inline-flex; align-items: center; gap: 8px; padding: 12px 28px; background: linear-gradient(135deg, #1a4a8a, #0d2a5c); border: 1px solid rgba(74,158,255,0.3); border-radius: 6px; color: var(--blue); font-family: 'DM Sans', sans-serif; font-size: 13px; font-weight: 600; text-decoration: none; cursor: pointer; transition: all 0.25s; }
  .btn:hover { background: linear-gradient(135deg, #2a5aaa, #1d3a7a); border-color: rgba(74,158,255,0.6); }
  @keyframes fadeUp { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
</style>
</head>
<body>
<div class="page">
  <div class="error-code">500</div>
  <div class="sep"></div>
  <div class="error-title">Internal Server Error</div>
  <div class="error-msg">Something went wrong on our end. Please try again in a few moments.</div>
  <div class="actions">
    <a class="btn" href="javascript:location.reload()">Try Again</a>
    <a class="btn" href="/">Back to Home</a>
  </div>
</div>
</body>
</html>`,
    },
    {
      name: 'Terminal Green',
      description: 'Retro terminal style with green text on black',
      error_codes: JSON.stringify([404, 500, 502, 503, 504]),
      theme: 'terminal',
      is_builtin: true,
      html_content: `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Error</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&display=swap');
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { height: 100%; background: #0c0c0c; color: #33ff33; font-family: 'JetBrains Mono', monospace; }
  body::before { content: ''; position: fixed; inset: 0; background: repeating-linear-gradient(0deg, rgba(0,255,0,0.03) 0px, transparent 1px, transparent 3px); pointer-events: none; }
  .page { height: 100vh; display: flex; flex-direction: column; justify-content: center; padding: 40px 60px; max-width: 700px; }
  .prompt { color: #888; font-size: 12px; margin-bottom: 8px; opacity: 0; animation: type 0.3s 0.2s forwards; }
  .cmd { font-size: 14px; margin-bottom: 24px; opacity: 0; animation: type 0.3s 0.4s forwards; }
  .cmd span { color: #ff3333; }
  .error-block { border-left: 2px solid #33ff33; padding-left: 16px; margin-bottom: 24px; opacity: 0; animation: type 0.3s 0.6s forwards; }
  .error-code { font-size: 48px; font-weight: 700; line-height: 1.2; }
  .error-msg { font-size: 13px; color: #aaa; margin-top: 8px; line-height: 1.6; }
  .action { opacity: 0; animation: type 0.3s 0.8s forwards; }
  .action a { color: #33ff33; text-decoration: none; font-size: 13px; border-bottom: 1px dashed #33ff33; padding-bottom: 2px; }
  .action a:hover { color: #66ff66; }
  .cursor { display: inline-block; width: 8px; height: 14px; background: #33ff33; animation: blink 1s infinite; margin-left: 4px; vertical-align: middle; }
  @keyframes type { to { opacity: 1; } }
  @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }
</style>
</head>
<body>
<div class="page">
  <div class="prompt">user@server:~$</div>
  <div class="cmd">curl -I <span>$request_uri</span></div>
  <div class="error-block">
    <div class="error-code">ERROR</div>
    <div class="error-msg">The requested resource could not be served.<br>The upstream server returned an unexpected response.</div>
  </div>
  <div class="action">
    <a href="/">$ cd /home</a><span class="cursor"></span>
  </div>
</div>
</body>
</html>`,
    },
    {
      name: 'Minimal Light',
      description: 'Clean minimal light theme',
      error_codes: JSON.stringify([404, 403, 500, 502, 503, 504]),
      theme: 'minimal-light',
      is_builtin: true,
      html_content: `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Error</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;700&display=swap');
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { height: 100%; background: #fafafa; color: #111; font-family: 'Inter', sans-serif; }
  .page { height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 40px; }
  .error-code { font-size: 120px; font-weight: 700; line-height: 1; color: #e0e0e0; letter-spacing: -4px; }
  .sep { width: 40px; height: 3px; background: #111; margin: 24px 0; border-radius: 2px; }
  .error-title { font-size: 18px; font-weight: 600; color: #333; margin-bottom: 8px; }
  .error-msg { font-size: 14px; color: #888; line-height: 1.7; text-align: center; max-width: 380px; margin-bottom: 32px; }
  .btn { padding: 10px 24px; background: #111; color: #fff; border: none; border-radius: 6px; font-family: 'Inter', sans-serif; font-size: 13px; font-weight: 500; text-decoration: none; cursor: pointer; transition: background 0.2s; }
  .btn:hover { background: #333; }
</style>
</head>
<body>
<div class="page">
  <div class="error-code">ERR</div>
  <div class="sep"></div>
  <div class="error-title">Something went wrong</div>
  <div class="error-msg">The page you requested is not available. Please try again or return to the homepage.</div>
  <a class="btn" href="/">Go Home</a>
</div>
</body>
</html>`,
    },
  ]);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('proxy_hosts', (t) => {
    t.dropColumn('client_max_body_size');
    t.dropColumn('proxy_connect_timeout');
    t.dropColumn('proxy_send_timeout');
    t.dropColumn('proxy_read_timeout');
    t.dropColumn('proxy_buffering');
    t.dropColumn('rate_limit_rps');
    t.dropColumn('rate_limit_burst');
    t.dropColumn('gzip_enabled');
    t.dropColumn('cors_enabled');
    t.dropColumn('custom_response_headers');
    t.dropColumn('error_page_id');
  });
  await knex.schema.dropTableIfExists('custom_pages');
}
