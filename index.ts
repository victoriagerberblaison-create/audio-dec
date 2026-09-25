// ============================================================
// Edge Function « audio-url »
// Reçoit : { track_id }  + le jeton de l'utilisateur connecté
// Renvoie : { url, expires_in }  → lien temporaire vers le fichier dans Cloudflare R2
//
// Les clés R2 restent ici, côté serveur (secrets Supabase) : elles ne sont jamais
// visibles dans le site.
// ============================================================
import { createClient } from 'npm:@supabase/supabase-js@2';
import { AwsClient } from 'npm:aws4fetch@1.0.20';

const R2_ACCOUNT_ID = Deno.env.get('R2_ACCOUNT_ID') ?? '';
const R2_ACCESS_KEY_ID = Deno.env.get('R2_ACCESS_KEY_ID') ?? '';
const R2_SECRET_ACCESS_KEY = Deno.env.get('R2_SECRET_ACCESS_KEY') ?? '';
const R2_BUCKET = Deno.env.get('R2_BUCKET') ?? 'audiotheque';
const EXPIRES = Number(Deno.env.get('R2_URL_EXPIRES') ?? 21600); // 6 h

// Sites autorisés à appeler la fonction (séparés par des virgules). Vide = tous.
const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') ?? '')
  .split(',').map((s) => s.trim()).filter(Boolean);

const r2 = new AwsClient({
  accessKeyId: R2_ACCESS_KEY_ID,
  secretAccessKey: R2_SECRET_ACCESS_KEY,
  service: 's3',
  region: 'auto',
});

function cors(req: Request): Record<string, string> {
  const origin = req.headers.get('origin') ?? '';
  const allow = ALLOWED_ORIGINS.length === 0 ? '*' : (ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]);
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
}

function json(req: Request, status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(req), 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export async function presign(key: string, expires = EXPIRES): Promise<string> {
  const path = key.split('/').map(encodeURIComponent).join('/');
  const url = new URL(`https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${R2_BUCKET}/${path}`);
  url.searchParams.set('X-Amz-Expires', String(expires));
  const signed = await r2.sign(new Request(url, { method: 'GET' }), { aws: { signQuery: true } });
  return signed.url;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors(req) });
  if (req.method !== 'POST') return json(req, 405, { error: 'Méthode non autorisée' });

  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
    return json(req, 500, { error: 'Secrets R2 manquants dans Supabase' });
  }

  // 1. Qui appelle ? (le jeton de session envoyé automatiquement par le site)
  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader.startsWith('Bearer ')) return json(req, 401, { error: 'Non connecté' });

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY') ?? req.headers.get('apikey') ?? '',
    { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } },
  );
  const { data: userData, error: userErr } = await supabase.auth.getUser(authHeader.slice(7));
  if (userErr || !userData?.user) return json(req, 401, { error: 'Session invalide' });

  // 2. Quelles pistes ? { track_ids: [..] } ou rien = toutes les pistes publiées
  let ids: string[] = [];
  try {
    const body = await req.json();
    const raw = body.track_ids ?? (body.track_id != null ? [body.track_id] : []);
    ids = (Array.isArray(raw) ? raw : [raw]).map(String).filter((s) => /^\d+$/.test(s)).slice(0, 1000);
  } catch { /* corps vide → toutes */ }

  // 3. Lecture du catalogue avec les droits de l'utilisateur (RLS : seulement les pistes publiées)
  let query = supabase.from('audio_tracks').select('id, fichier').limit(1000);
  if (ids.length) query = query.in('id', ids);
  const { data: tracks, error: trackErr } = await query;
  if (trackErr) return json(req, 500, { error: trackErr.message });

  // 4. Un lien temporaire R2 par piste (signature calculée localement, aucun appel à R2)
  const urls: Record<string, string> = {};
  for (const t of tracks ?? []) {
    if (!t.fichier) continue;
    urls[String(t.id)] = await presign(String(t.fichier).trim().replace(/^\/+/, ''));
  }
  return json(req, 200, { urls, expires_in: EXPIRES });
});
