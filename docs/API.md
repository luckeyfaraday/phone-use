# Phone-Use HTTP API

Base URL: `http://127.0.0.1:7333` through an ADB forward for Android, or `http://127.0.0.1:7334` from `phone-use-mcp ios up` for an iPhone (see [the iPhone section](#iphone)). Every request needs `x-phone-use-token: TOKEN`. POST bodies are UTF-8 JSON with `Content-Length`; chunked bodies are not supported. Maximum body size is 1 MiB. The API is intended for one controlling agent at a time.

| Method | Route | Input / output |
| --- | --- | --- |
| GET | `/status` | `connected`, `paused`, `screenshots`, `version`, `android`, `device` |
| GET | `/screen` | `app`, readable `text`, numbered `elements`, `paused` |
| GET | `/apps` | `apps`: `package`, `label`, `system` |
| GET | `/screenshot?scale=0.5&quality=70` | JPEG `data` in base64, `mime`, `width`, `height`, `screen_width`, `screen_height`, `scale_to_screen` |
| POST | `/tap` | `{ "id": 2 }` or `{ "x": 100, "y": 200 }` |
| POST | `/longpress` | Same target as tap |
| POST | `/type` | `{ "text": "hello", "id": 2, "append": false }`; id and append optional |
| POST | `/scroll` | `{ "direction": "down", "id": 3 }`; id optional; down/up/left/right |
| POST | `/swipe` | `{ "x1": 100, "y1": 700, "x2": 100, "y2": 200, "ms": 350 }` |
| POST | `/key` | `{ "key": "back" }`; back/home/recents/notifications/quick_settings/power/lock (lock: Android 9+) |
| POST | `/open` | `{ "package": "com.android.settings" }` |
| POST | `/pause` | Blocks access and stops screen sharing |

Actions return `{ "ok": true, "screen": { ... } }`. Check `ok` and the returned screen. Optional `settle_ms` waits after an action (default 700, maximum 5000). Element IDs are invalidated by the next screen read. Tap coordinates are full-screen pixels; multiply screenshot coordinates by `scale_to_screen`.

Errors use `{ "error": "message" }`: HTTP 401 for an invalid token, 423 while paused, and 400 for invalid actions or missing screenshot consent. Malformed HTTP is disconnected. `/status` and `/pause` remain available while paused. `/resume` is deliberately unavailable: the person holding the phone resumes access. Calls other than status/pause are also blocked while Android's screen-sharing consent prompt is open.

Screen sharing is started from the Phone-Use app, using Android's [MediaProjection consent flow](https://developer.android.com/media/grow/media-projection). One virtual display is retained for the session; its image surface is attached only while a screenshot is requested. Image buffers are released after encoding, and no screenshot is written to the phone's filesystem.

USB setup reads a token through `content://dev.phoneuse.token/token`. The provider accepts only Android's ADB shell or root UID. Other apps cannot query it. Authentication requires an already trusted debugging connection.

## iPhone

`phone-use-mcp ios up` serves the same routes for an iPhone from the computer it's connected to, using the same token header and error codes. The differences:

- Coordinates and bounds are iOS screen points, not pixels. `/screen` reports the size, for example `screen: 390x844 points`.
- `/status` adds `"platform": "ios"`, `ios` (the iOS version) and `locked`, and reports the model identifier (for example `iPhone14,2`) as `device`. `paused` is true while the iPhone is locked.
- While the iPhone is locked, everything except `/status` and `/pause` returns HTTP 423. `/pause` locks the iPhone; unlocking it on the phone resumes.
- `/screenshot` returns `"mime": "image/png"`; `quality` is ignored.
- `/open` takes a bundle ID as `package`, and `/apps` lists bundle IDs as `package`.
- `/key` accepts back, home, recents, quick_settings and lock. `back` is a left-edge swipe, `recents` opens the app switcher and `quick_settings` opens Control Center. `notifications` returns 400: Notification Center is the lock screen's cover sheet, during which the iPhone reports itself as locked.
- A `\n` at the end of `/type` text presses Return.
