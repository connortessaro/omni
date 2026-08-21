# Ground truth — psf__requests-2674

Do not show this file, or `gold.patch`, to the model. `issue.md` is the only thing a
candidate is handed.

## Why this instance

From SWE-bench Lite, chosen against a stated criterion: the issue text names no
file, no function and no line, and the fix lives somewhere the issue never points
at. It is also phrased as a question ("I don't know if it's a design goal of
requests to...") rather than a bug report, with no repro steps and no stack trace —
which is what an ambiguous open-source issue actually looks like.

Reaching the answer needs knowledge that spans files:

- `requests/adapters.py` — `HTTPAdapter.send` is where urllib3 is called and where
  its exceptions are meant to be translated. This is the file to change.
- `requests/exceptions.py` — the `requests.exceptions` types to translate into.
- `requests/packages/urllib3/exceptions.py` — the vendored urllib3 exceptions that
  are leaking.
- `requests/models.py` — `Response.iter_content` is the second leak path, where
  `DecodeError` escapes while the body is being read, outside `HTTPAdapter.send`.

## The change

`requests/adapters.py`, in `HTTPAdapter.send`: import `ClosedPoolError` from the
vendored urllib3 exceptions and add a clause that re-raises it as
`requests.exceptions.ConnectionError(e, request=request)`, alongside the existing
`ConnectTimeoutError` / `_ProxyError` clauses. See `gold.patch`.

## Grading a response

Full credit:

1. Names `requests/adapters.py` as the file to change.
2. Locates `HTTPAdapter.send`'s exception-handling block, not some other function.
3. Proposes catching the leaking urllib3 exception and re-raising it as a
   `requests.exceptions` type, preserving `request=request`.

Partial credit:

- Names `adapters.py` but the wrong function.
- Identifies the wrapping *pattern* correctly but points at `sessions.py` (the
  caller) instead of the adapter.
- Covers `DecodeError` via `models.py::iter_content` but misses the adapter. This is
  a defensible answer for the DecodeError half of the issue and should be scored as
  partial, not wrong.

No credit:

- Suggests the caller catch urllib3 exceptions itself.
- Suggests changing vendored urllib3.
- References a symbol that does not exist at this commit.

## Corroboration

The upstream maintainer thread (`hints_text` on the SWE-bench row, deliberately not
checked in here) converges on `adapters.py`, confirms `ClosedPoolError` as the
concrete leak, and notes `LocationParseError` and `DecodeError` as further ones.
That thread is the reason the grading above treats `models.py::iter_content` as
partial rather than wrong.
