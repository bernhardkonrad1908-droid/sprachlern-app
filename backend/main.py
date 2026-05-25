"""
FastAPI Backend – Anthropic-Proxy.

Reicht Requests vom Frontend an die Anthropic-API durch und hält den
API-Key serverseitig. Streaming wird transparent als SSE durchgeleitet.
"""

import os
import httpx
from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import StreamingResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware

ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY")
if not ANTHROPIC_API_KEY:
    raise RuntimeError("ANTHROPIC_API_KEY environment variable not set")

ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
ANTHROPIC_VERSION = "2023-06-01"

ALLOWED_ORIGINS = os.environ.get(
    "ALLOWED_ORIGINS", "*"
).split(",")

app = FastAPI(title="Sprachlern-App Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


@app.get("/api/health")
async def health():
    return {"status": "ok"}


@app.post("/api/messages")
async def messages(request: Request):
    """
    Proxy für Anthropic /v1/messages.
    Unterstützt Streaming wenn body["stream"] == True.
    """
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON")

    headers = {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
    }

    is_stream = bool(body.get("stream", False))

    if is_stream:
        async def event_stream():
            async with httpx.AsyncClient(timeout=httpx.Timeout(60.0, read=120.0)) as client:
                async with client.stream(
                    "POST", ANTHROPIC_URL, headers=headers, json=body
                ) as resp:
                    if resp.status_code != 200:
                        err_text = await resp.aread()
                        yield f"data: {{\"error\": \"upstream_{resp.status_code}\", \"detail\": {err_text.decode('utf-8', errors='replace')!r}}}\n\n".encode()
                        return
                    async for chunk in resp.aiter_bytes():
                        if chunk:
                            yield chunk

        return StreamingResponse(
            event_stream(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    # Non-streaming
    async with httpx.AsyncClient(timeout=httpx.Timeout(60.0)) as client:
        resp = await client.post(ANTHROPIC_URL, headers=headers, json=body)
        if resp.status_code != 200:
            return JSONResponse(
                status_code=resp.status_code,
                content={"error": "upstream_error", "detail": resp.text},
            )
        return JSONResponse(content=resp.json())
