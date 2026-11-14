// Comate's allowance is not in the license its IDE spends. The points an
// account holds (its seat's, its add-on packages', the ones its site gives
// away) are its website's, read with the Baidu session cookie a signed-in
// browser holds. The IDE's own quota endpoints answer nothing for such an
// account, so the plugin asks the site the user pastes that cookie from.
const WEB = "https://comate.baidu.com"
const BEIJING = 8 * 60 * 60 * 1000
// A pasted value alone is taken as the cookie only when it is one: a long
// token of the characters a BDUSS is made of (base64's, and ~ and -), not
// a license, which is a UUID.
const BARE_VALUE = /^[A-Za-z0-9+/=_.~-]{32,}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const USAGE_TIMEOUT_MS = 5000
const str = (value) => (typeof value === "string" ? value.trim() : "")

// cookieOf reads the cookie a user pastes: the BDUSS pair, the value the
// site's cookie table shows, or a whole Cookie header it is among.
export function cookieOf(input) {
  const text = str(input)
  if (!text) return ""
  const pair = /(?:^|[;\s])BDUSS=([^;\s]+)/.exec(text)
  if (pair) return "BDUSS=" + pair[1]
  return BARE_VALUE.test(text) && !UUID.test(text) ? "BDUSS=" + text : ""
}

// cookieIn is the cookie a signed-in account keeps in its metadata.
export function cookieIn(auth) {
  return cookieOf(auth?.metadata?.cookie)
}

// beijing reads the site's own clock ("2026-11-20 20:06:53", UTC+8) as ms.
function beijing(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(str(value))
  if (!m) return 0
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 8, +m[5], +m[6])
}

// amount reads a package's points ("+5000.00").
function amount(value) {
  const n = Number(String(value ?? "").replace(/[^\d.-]/g, ""))
  return Number.isFinite(n) ? n : 0
}

const count = (value) => (Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0)

async function read(path, cookie, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(new DOMException("Comate's website did not answer in time", "TimeoutError")), options.timeoutMs ?? USAGE_TIMEOUT_MS)
  const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal
  try {
    const response = await fetchImpl(WEB + path, {
      headers: { cookie, accept: "application/json", "accept-language": "zh-CN,zh" },
      redirect: "error",
      signal,
    })
    if (!response.ok) throw new Error(`Comate's website answered HTTP ${response.status}`)
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

// Neither text may say "sign in again": magpie marks an account's sign-in
// lapsed when a usage read's error does (internal/provider/plugin_usage.go,
// signInGone), and a cookie that is missing or past its life is not the
// license's, which every request still spends.
const REJECTED = "Comate no longer accepts this web cookie: copy a fresh BDUSS from comate.baidu.com and add the cookie method again (it is the cookie, not the license)."
const UNREAD = "Comate's website could not be read; try again later."

// userOf is the account a cookie is signed in to: the license its IDE
// spends, and the name the site shows.
export async function userOf(cookie, options = {}) {
  const answer = await read("/api/user", cookie, options).catch(() => null)
  const license = str(answer?.data?.license)
  if (answer?.status !== "OK" || !license) throw new Error(REJECTED)
  return { license, username: str(answer?.data?.username) || str(answer?.data?.displayName) }
}

// soonest is when the credits left in a pool's packages are lost, and how
// many go then: the earliest end still to come, not a package already over.
function soonest(list, now) {
  const rows = (Array.isArray(list) ? list : [])
    .map((row) => ({ at: beijing(row?.expireTime), n: amount(row?.points) }))
    .filter((row) => row.at > now && row.n > 0)
  if (!rows.length) return null
  const at = Math.min(...rows.map((row) => row.at))
  return { runsOutAt: new Date(at).toISOString(), runsOut: rows.filter((row) => row.at === at).reduce((sum, row) => sum + row.n, 0) }
}

// pointsWindow is a pool as magpie draws it: what of it is used, in points,
// and, for a pool that ends on a day of its own, when what is left goes.
function pointsWindow(name, pool, list, now, extra = {}) {
  const limit = count(pool?.totalPoints)
  if (!(limit > 0)) return null
  const used = count(pool?.usedPoints)
  const window = { name, used: (used / limit) * 100, amount: used, limit, unit: "credits", ...extra }
  const lost = soonest(list, now)
  if (lost) Object.assign(window, lost)
  return window
}

// quotaOf reads the account's allowance: its seat's points, which the site
// gives back each period, and its add-on and gift points, which end on
// their own days. The package lists are only needed for those days.
export async function quotaOf(cookie, options = {}) {
  const now = options.now ?? Date.now()
  let balance
  try {
    balance = await read("/api/user/agent/balance", cookie, options)
  } catch (error) {
    return { windows: [], error: error?.name === "TimeoutError" ? UNREAD : `${UNREAD} (${str(error?.message)})` }
  }
  if (balance?.status === "UNAUTHORIZED") return { windows: [], error: REJECTED }
  if (balance?.status !== "OK" || !balance?.data) return { windows: [], error: UNREAD }

  const detail = async (path) => {
    try {
      const answer = await read(path, cookie, options)
      return answer?.status === "OK" && Array.isArray(answer.data) ? answer.data : []
    } catch {
      return []
    }
  }
  const [addon, gift] = await Promise.all([
    detail("/api/user/agent/addon/detail"),
    detail("/api/user/agent/gift/detail"),
  ])

  const data = balance.data
  const until = beijing(data.seatPointsNextUpdate)
  const windows = [
    pointsWindow("Seat", data.seatPoints, [], now, until ? { resetsAt: new Date(until).toISOString() } : {}),
    pointsWindow("Add-on", data.addonPoints, addon, now, { aside: true }),
    pointsWindow("Gift", data.giftPoints, gift, now, { aside: true }),
  ].filter(Boolean)
  return { windows, error: "" }
}