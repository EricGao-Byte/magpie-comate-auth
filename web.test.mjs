// Comate's allowance is not in the license its IDE spends: the points an
// account holds are its website's, read with the Baidu session cookie the
// user pastes once. These tests hold the paste, the sign-in it makes, and
// the windows magpie draws from what the site answers.
import test from 'node:test'
import assert from 'node:assert/strict'
import { ComateAuthPlugin } from './index.mjs'
import { cookieOf, cookieIn, quotaOf, userOf } from './web.mjs'

const LIC = '11111111-2222-3333-4444-555555555555'
// a BDUSS carries base64's characters and these; the real one has dashes
const VALUE = 'ZmFrZS1jb29raWUtfmFrZWNvb2tpZXZhbHVlLTEyMzQ1Njc4OTAtfg'
const COOKIE = 'BDUSS=' + VALUE
const OTHER = 'WlpaLXN0aWxsLW5vdC10aGUtY29va2llLXRoYXQtd29ya3M'
const NOW = Date.parse('2026-11-14T00:00:00+08:00')
// magpie marks an account lapsed when a usage read's error says this
const LAPSES = /sign-in has (expired|lapsed)|sign in again/i

const BALANCE = {
  status: 'OK',
  message: '操作成功！',
  data: {
    userId: '',
    seatPointsNextUpdate: '2026-12-13 20:00:21',
    seatPoints: { totalPoints: 25000, usedPoints: 5000, availablePoints: 20000 },
    addonPoints: { totalPoints: 5000, usedPoints: 0, availablePoints: 5000 },
    giftPoints: { totalPoints: 6000, usedPoints: 0, availablePoints: 6000 },
    standalonePackPoints: { totalPoints: 0, usedPoints: 0, availablePoints: 0 },
  },
}
const ADDON = {
  status: 'OK',
  data: [{ type: 'Dumate增量积分包', occurTime: '2026-11-13 20:22:01', expireTime: '2026-11-20 20:06:53', points: '+5000.00' }],
}
const GIFT = {
  status: 'OK',
  data: [
    { type: '免费发放', occurTime: '2026-11-14 00:01:08', expireTime: '2026-12-13 23:59:59', points: '+500.00' },
    { type: '免费发放', occurTime: '2026-11-13 20:07:01', expireTime: '2026-12-12 23:59:59', points: '+500.00' },
    { type: '免费发放', occurTime: '2026-01-20 09:08:31', expireTime: '长期有效', points: '+5000.00' },
  ],
}

function site(routes) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(url).pathname
    calls.push({ path, cookie: String(init.headers?.cookie ?? '') })
    const route = routes[path]
    if (route === undefined) return Response.json({ status: 'NOT_FOUND', data: null }, { status: 404 })
    return Response.json(typeof route === 'function' ? route() : route)
  }
  return { calls, fetchImpl }
}

const windows = [
  { name: 'Seat', used: 20, amount: 5000, limit: 25000, unit: 'credits', resetsAt: '2026-12-13T12:00:21.000Z' },
  { name: 'Add-on', used: 0, amount: 0, limit: 5000, unit: 'credits', aside: true, runsOutAt: '2026-11-20T12:06:53.000Z', runsOut: 5000 },
  { name: 'Gift', used: 0, amount: 0, limit: 6000, unit: 'credits', aside: true, runsOutAt: '2026-12-12T15:59:59.000Z', runsOut: 500 },
]

const cookieMethod = (hooks) => hooks.auth.methods.find((m) => m.type === 'api' && /cookie/i.test(m.label))

test('a pasted cookie is read from every shape a browser copies', () => {
  // the value alone, as DevTools' cookie table shows it
  assert.equal(cookieOf(VALUE), COOKIE)
  assert.equal(cookieOf('  ' + COOKIE + '  '), COOKIE)
  // a whole Cookie header, or the pair among others
  assert.equal(cookieOf('Cookie: ' + COOKIE + '; PSTM=1700000000; BIDUPSID=ABC'), COOKIE)
  assert.equal(cookieOf('  ' + COOKIE + ' ;  SESSION=x'), COOKIE)
  // a license is not a cookie, and nothing else is either
  assert.equal(cookieOf(LIC), '')
  assert.equal(cookieOf('PSTM=1700000000'), '')
  assert.equal(cookieOf('BDUSS='), '')
  assert.equal(cookieOf('not a cookie'), '')
  assert.equal(cookieOf(''), '')
})

test('an account keeps the cookie it was signed in with', () => {
  assert.equal(cookieIn({ metadata: { cookie: COOKIE } }), COOKIE)
  assert.equal(cookieIn({ key: LIC }), '')
})

test('a cookie signs in by the license its account names', async () => {
  const { fetchImpl, calls } = site({
    '/api/user': { status: 'OK', data: { username: '二十二时代', license: LIC, userType: 'INDIVIDUAL' } },
  })
  const hooks = await ComateAuthPlugin({}, { fetchImpl })
  const method = cookieMethod(hooks)
  assert.ok(method, 'the plugin offers a way to sign in by its website cookie')
  assert.equal(method.prompts.length, 1)
  assert.equal(method.prompts[0].key, 'cookie')

  const r = await method.authorize({ cookie: '  ' + COOKIE + ' ; PSTM=1' }, {})
  assert.equal(r.type, 'success')
  // the license its website names, the one the chat path spends
  assert.equal(r.key, LIC)
  assert.equal(r.metadata.cookie, COOKIE)
  assert.equal(r.metadata.source, 'comate-paste')
  assert.equal(r.metadata.username, '二十二时代')
  // no account id: a sign-in of the same license merges into the account
  // signed in by the license alone (host.js settle), never a second one
  assert.equal(r.accountId, undefined)
  assert.deepEqual(calls.map((c) => c.path), ['/api/user'])
})

test('a cookie the site turns away fails the sign-in, and signs in nothing', async () => {
  const { fetchImpl } = site({ '/api/user': { status: 'UNAUTHORIZED', message: '没有授权!', data: null } })
  const hooks = await ComateAuthPlugin({}, { fetchImpl })
  const method = cookieMethod(hooks)

  const turnedAway = await method.authorize({ cookie: COOKIE.replace(VALUE, OTHER) }, {})
  assert.equal(turnedAway.type, 'failed')
  assert.match(turnedAway.error, /cookie/i)
  assert.match(turnedAway.error, /license/) // pasting the license here is said not to be it

  const empty = await method.authorize({ cookie: '  ' }, {})
  assert.equal(empty.type, 'failed')
})

test('the allowance is the points its website reports, in Beijing time', async () => {
  const { fetchImpl, calls } = site({
    '/api/user/agent/balance': BALANCE,
    '/api/user/agent/addon/detail': ADDON,
    '/api/user/agent/gift/detail': GIFT,
  })
  const quota = await quotaOf(COOKIE, { fetchImpl, now: NOW })
  assert.deepEqual(quota.windows, windows)
  assert.equal(quota.error, '')
  assert.ok(calls.every((c) => c.cookie === COOKIE))
})

test('a pool with nothing in it is left out', async () => {
  const { fetchImpl } = site({
    '/api/user/agent/balance': {
      status: 'OK',
      data: {
        seatPointsNextUpdate: '2026-12-13 20:00:21',
        seatPoints: { totalPoints: 25000, usedPoints: 25000, availablePoints: 0 },
        addonPoints: { totalPoints: 0, usedPoints: 0, availablePoints: 0 },
        giftPoints: { totalPoints: 0, usedPoints: 0, availablePoints: 0 },
        standalonePackPoints: { totalPoints: 0, usedPoints: 0, availablePoints: 0 },
      },
    },
  })
  const quota = await quotaOf(COOKIE, { fetchImpl, now: NOW })
  assert.deepEqual(quota.windows, [
    { name: 'Seat', used: 100, amount: 25000, limit: 25000, unit: 'credits', resetsAt: '2026-12-13T12:00:21.000Z' },
  ])
})

test('a package that has ended is not what runs out', async () => {
  const { fetchImpl } = site({
    '/api/user/agent/balance': BALANCE,
    '/api/user/agent/addon/detail': {
      status: 'OK',
      data: [
        { type: '加量包', occurTime: '2026-10-01 00:00:00', expireTime: '2026-11-01 00:00:00', points: '+900.00' },
        { type: '加量包', occurTime: '2026-11-13 20:22:01', expireTime: '2026-11-20 20:06:53', points: '+5000.00' },
      ],
    },
    '/api/user/agent/gift/detail': GIFT,
  })
  const quota = await quotaOf(COOKIE, { fetchImpl, now: NOW })
  assert.equal(quota.windows[1].runsOutAt, '2026-11-20T12:06:53.000Z')
  assert.equal(quota.windows[1].runsOut, 5000)
})

test('the detail lists are not needed for the totals', async () => {
  const { fetchImpl } = site({ '/api/user/agent/balance': BALANCE })
  const quota = await quotaOf(COOKIE, { fetchImpl, now: NOW })
  assert.deepEqual(quota.windows.map((w) => w.name), ['Seat', 'Add-on', 'Gift'])
  assert.equal(quota.windows[1].runsOutAt, undefined)
  assert.equal(quota.windows[1].limit, 5000)
})

test('a cookie the site no longer takes is said so, and rests nothing', async () => {
  const { fetchImpl } = site({ '/api/user/agent/balance': { status: 'UNAUTHORIZED', message: '没有授权!', data: null } })
  const quota = await quotaOf(COOKIE, { fetchImpl, now: NOW })
  assert.deepEqual(quota.windows, [])
  assert.match(quota.error, /cookie/i)
  assert.doesNotMatch(quota.error, LAPSES)
  assert.equal(quota.signIn, undefined)
})

test('a website that cannot be read says so without a figure', async () => {
  const { fetchImpl } = site({})
  const quota = await quotaOf(COOKIE, { fetchImpl, now: NOW })
  assert.deepEqual(quota.windows, [])
  assert.ok(quota.error)
  assert.doesNotMatch(quota.error, LAPSES)
  assert.equal(quota.signIn, undefined)
})

test('the usage hook tells an account with no cookie where to get one', async () => {
  const { fetchImpl } = site({})
  const hooks = await ComateAuthPlugin({}, { fetchImpl })
  const usage = await hooks.auth.usage(async () => ({ type: 'api', key: LIC, metadata: { source: 'comate-paste' } }), { id: 'comate' })
  assert.deepEqual(usage.windows, [])
  assert.match(usage.error, /cookie/i)
  assert.doesNotMatch(usage.error, LAPSES)
  assert.equal(usage.signIn, undefined)
})

test('the usage hook reads the account signed in by cookie, and names it', async () => {
  const { fetchImpl, calls } = site({
    '/api/user/agent/balance': BALANCE,
    '/api/user/agent/addon/detail': ADDON,
    '/api/user/agent/gift/detail': GIFT,
  })
  const hooks = await ComateAuthPlugin({}, { fetchImpl })
  const usage = await hooks.auth.usage(async () => ({
    type: 'api',
    key: LIC,
    metadata: { source: 'comate-paste', cookie: COOKIE, username: '二十二时代' },
  }), { id: 'comate' })
  assert.deepEqual(usage.windows, windows)
  assert.equal(usage.error, '')
  assert.equal(usage.user, '二十二时代')
  assert.equal(usage.signIn, undefined)
  assert.ok(calls.every((c) => c.cookie === COOKIE))
})

test('a usage read for another provider asks nothing', async () => {
  const { fetchImpl, calls } = site({})
  const hooks = await ComateAuthPlugin({}, { fetchImpl })
  const usage = await hooks.auth.usage(async () => ({ type: 'api', key: 'sk-other', metadata: { source: 'elsewhere' } }), { id: 'other' })
  assert.deepEqual(usage, {})
  assert.equal(calls.length, 0)
})

test('userOf reads the license and the name its website gives', async () => {
  const { fetchImpl } = site({
    '/api/user': { status: 'OK', data: { username: '二十二时代', displayName: '显示名', license: LIC } },
  })
  assert.deepEqual(await userOf(COOKIE, { fetchImpl }), { license: LIC, username: '二十二时代' })
})