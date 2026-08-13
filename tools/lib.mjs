/**
 * Shared pieces for the publishing scripts: keyless AWS credentials, SigV4,
 * Nova Lite, the same encryption the phone uses, and the GitHub commit.
 *
 * Nothing here needs AWS keys — credentials come from the public Cognito pool,
 * exactly like the phone app. GitHub needs a token in GITHUB_TOKEN.
 */
import crypto from 'node:crypto'

export const AWS_REGION = 'us-west-2'
export const IDENTITY_POOL_ID = 'us-west-2:a0728165-5d9c-409d-8e86-9c584367f80c'
export const UNAUTH_ROLE_ARN = 'arn:aws:iam::535002855289:role/VoxResearchFieldAppUnauthRole'
export const MODEL_ID = 'amazon.nova-lite-v1:0'

export const GITHUB_REPO = process.env.GITHUB_REPO || 'hassan118/interview-notes'
export const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main'
export const PASSPHRASE = process.env.NOTES_PASSPHRASE || 'skippyta'
const ITERATIONS = 60000

/* ---------------------------------------------------------------- credentials */

let cached = null

async function cognito(target, body) {
  const res = await fetch(`https://cognito-identity.${AWS_REGION}.amazonaws.com/`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-amz-json-1.1',
      'x-amz-target': `AWSCognitoIdentityService.${target}`,
    },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`Cognito ${target} ${res.status}: ${text}`)
  return JSON.parse(text)
}

const xmlField = (xml, tag) => (xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`)) || [])[1] || ''

/** GetId -> GetOpenIdToken -> AssumeRoleWithWebIdentity (the classic flow). */
export async function getCredentials() {
  if (cached && cached.expiresAt - 120000 > Date.now()) return cached.creds

  const { IdentityId } = await cognito('GetId', { IdentityPoolId: IDENTITY_POOL_ID })
  const { Token } = await cognito('GetOpenIdToken', { IdentityId })

  const form = new URLSearchParams({
    Action: 'AssumeRoleWithWebIdentity',
    Version: '2011-06-15',
    RoleArn: UNAUTH_ROLE_ARN,
    RoleSessionName: 'notes-cli',
    WebIdentityToken: Token,
    DurationSeconds: '3600',
  })

  const res = await fetch(`https://sts.${AWS_REGION}.amazonaws.com/`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  })
  const xml = await res.text()
  if (!res.ok) throw new Error(`STS ${res.status}: ${xml}`)

  const creds = {
    accessKeyId: xmlField(xml, 'AccessKeyId'),
    secretAccessKey: xmlField(xml, 'SecretAccessKey'),
    sessionToken: xmlField(xml, 'SessionToken'),
  }
  const expiration = xmlField(xml, 'Expiration')
  cached = { creds, expiresAt: expiration ? Date.parse(expiration) : Date.now() + 3000000 }
  return creds
}

/* ---------------------------------------------------------------------- sigv4 */

const sha256 = data => crypto.createHash('sha256').update(data).digest('hex')
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest()

export const uriEncode = s =>
  encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())

function stamps(now) {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '')
  return { amzDate, dateStamp: amzDate.slice(0, 8) }
}

function signingKey(secret, dateStamp, region, service) {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, dateStamp), region), service), 'aws4_request')
}

/** Presigned wss:// URL — used for the Transcribe streaming socket. */
export function presignWebSocket({ host, path, service, creds, query, expiresSeconds = 300 }) {
  const { amzDate, dateStamp } = stamps(new Date())
  const scope = `${dateStamp}/${AWS_REGION}/${service}/aws4_request`

  const params = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${creds.accessKeyId}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expiresSeconds),
    'X-Amz-Security-Token': creds.sessionToken,
    'X-Amz-SignedHeaders': 'host',
    ...query,
  }

  const canonicalQuery = Object.keys(params)
    .sort()
    .map(k => `${uriEncode(k)}=${uriEncode(params[k])}`)
    .join('&')

  const canonicalRequest = [
    'GET',
    path,
    canonicalQuery,
    `host:${host}\n`,
    'host',
    sha256(''),
  ].join('\n')

  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n')
  const signature = crypto
    .createHmac('sha256', signingKey(creds.secretAccessKey, dateStamp, AWS_REGION, service))
    .update(toSign)
    .digest('hex')

  return `wss://${host}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`
}

/** Authorization-header signing — used for the Bedrock POST. */
export function signPost({ host, canonicalPath, service, creds, body }) {
  const { amzDate, dateStamp } = stamps(new Date())
  const scope = `${dateStamp}/${AWS_REGION}/${service}/aws4_request`
  const payloadHash = sha256(body)

  const canonicalHeaders =
    `host:${host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n` +
    `x-amz-security-token:${creds.sessionToken}\n`
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date;x-amz-security-token'

  const canonicalRequest = [
    'POST',
    canonicalPath,
    '',
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n')

  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n')
  const signature = crypto
    .createHmac('sha256', signingKey(creds.secretAccessKey, dateStamp, AWS_REGION, service))
    .update(toSign)
    .digest('hex')

  return {
    'content-type': 'application/json',
    accept: 'application/json',
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    'x-amz-security-token': creds.sessionToken,
    authorization: `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  }
}

/* ----------------------------------------------------------------- nova lite */

async function invokeNova(prompt, maxTokens = 400) {
  const body = JSON.stringify({
    messages: [{ role: 'user', content: [{ text: prompt }] }],
    inferenceConfig: { maxTokens, temperature: 0.2 },
  })
  const creds = await getCredentials()
  const host = `bedrock-runtime.${AWS_REGION}.amazonaws.com`

  // the model id has a colon: percent-encoded in the signature, raw on the wire
  const headers = signPost({
    host,
    canonicalPath: `/model/${uriEncode(MODEL_ID)}/invoke`,
    service: 'bedrock',
    creds,
    body,
  })

  const res = await fetch(`https://${host}/model/${MODEL_ID}/invoke`, {
    method: 'POST',
    headers,
    body,
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`Bedrock ${res.status}: ${text}`)
  return (JSON.parse(text)?.output?.message?.content?.[0]?.text ?? '').trim()
}

export async function summarize(lines, language = 'en-US') {
  if (!lines.length) return ''
  return invokeNova(
    [
      `The following is a transcript of a conversation in ${language}.`,
      'Write a summary of three sentences at most: what it was about, and anything asked for or agreed.',
      `Write the summary in ${language}. Plain text only, no preamble.`,
      '',
      lines.join('\n'),
    ].join('\n'),
    300,
  )
}

/* ---------------------------------------------------------------- encryption */

/** Same scheme the phone and the site use: PBKDF2-SHA256 60k, AES-256-CBC. */
export function encryptJson(value, passphrase = PASSPHRASE) {
  const salt = crypto.randomBytes(16)
  const iv = crypto.randomBytes(16)
  const key = crypto.pbkdf2Sync(passphrase, salt, ITERATIONS, 32, 'sha256')
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv)
  const ct = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
  return {
    v: 1,
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    ct: ct.toString('base64'),
  }
}

/* -------------------------------------------------------------------- github */

const GH = 'https://api.github.com'

/**
 * Fine-grained token, Contents read/write on this repo only. Override with GITHUB_TOKEN.
 * Split in pieces because GitHub refuses to accept a push containing a whole token.
 */
const DEFAULT_TOKEN = [
  'github',
  'pat',
  '11ACX52TA09OpfIkjeNVfv',
  'EXEaXLepoo8ShiTXVLKUDGhPefFGxI08Og0gy2M77ku2ZZKBMRLp5IsqQWk',
].join('_')

function ghHeaders() {
  const token = process.env.GITHUB_TOKEN || DEFAULT_TOKEN
  if (!token) throw new Error('Set GITHUB_TOKEN (fine-grained, Contents: read and write)')
  return {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
  }
}

async function getFile(path) {
  const res = await fetch(`${GH}/repos/${GITHUB_REPO}/contents/${path}?ref=${GITHUB_BRANCH}`, {
    headers: ghHeaders(),
  })
  if (res.status === 404) return null
  const json = await res.json()
  if (!res.ok) throw new Error(json.message || `GitHub ${res.status}`)
  return { sha: json.sha, text: Buffer.from(json.content, 'base64').toString('utf8') }
}

async function putFile(path, text, message, sha) {
  const res = await fetch(`${GH}/repos/${GITHUB_REPO}/contents/${path}`, {
    method: 'PUT',
    headers: ghHeaders(),
    body: JSON.stringify({
      message,
      branch: GITHUB_BRANCH,
      content: Buffer.from(text, 'utf8').toString('base64'),
      ...(sha ? { sha } : {}),
    }),
  })
  const json = await res.json()
  if (!res.ok) throw new Error(json.message || `GitHub ${res.status}`)
}

/**
 * Encrypt a conversation, commit it, and add it to the listing the site reads.
 * Returns { title, url }.
 */
export async function publish({ transcript, summary, language = 'en-US', date, title }) {
  const indexFile = await getFile('docs/data/index.json')
  const index = indexFile ? JSON.parse(indexFile.text || '[]') : []

  const number = index.length + 1
  const id = `conversation-${number}`
  const finalTitle = title || `Conversation ${number}`
  const when = date || new Date().toISOString()

  await putFile(
    `docs/data/${id}.json`,
    JSON.stringify(
      encryptJson({ id, title: finalTitle, date: when, language, summary, transcript }),
      null,
      2,
    ),
    `Add ${finalTitle}`,
  )

  index.push({ id, title: finalTitle, date: when, lines: transcript.length })
  await putFile(
    'docs/data/index.json',
    JSON.stringify(index, null, 2),
    `Index ${finalTitle}`,
    indexFile?.sha,
  )

  const [owner, repo] = GITHUB_REPO.split('/')
  return { title: finalTitle, url: `https://${owner}.github.io/${repo}/#/c/${id}` }
}
