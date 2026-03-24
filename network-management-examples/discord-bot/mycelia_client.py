"""HTTP client for the Mycelia mutual aid API."""

import logging
from dataclasses import dataclass
from typing import Any

import aiohttp

log = logging.getLogger("mycelia-bot.client")


@dataclass
class MyceliaResponse:
    """Wrapper for Mycelia API responses."""

    ok: bool
    status: int
    data: dict[str, Any] | None
    error: str | None


class MyceliaClient:
    """Async HTTP client for Mycelia API."""

    def __init__(self, base_url: str, api_key: str):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self._session: aiohttp.ClientSession | None = None

    async def _get_session(self) -> aiohttp.ClientSession:
        """Return a shared HTTP session, creating one if needed."""
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(
                headers={"Authorization": f"Bearer {self.api_key}"},
                timeout=aiohttp.ClientTimeout(total=15),
            )
        return self._session

    async def close(self):
        """Close the underlying HTTP session."""
        if self._session and not self._session.closed:
            await self._session.close()

    async def _request(
        self, method: str, path: str, json: dict | None = None
    ) -> MyceliaResponse:
        """Make an API request with standard error handling."""
        session = await self._get_session()
        url = f"{self.base_url}{path}"
        try:
            async with session.request(method, url, json=json) as resp:
                body = await resp.json()
                if resp.status >= 400:
                    error_msg = "Unknown error"
                    # Mycelia error responses vary -- handle defensively
                    if isinstance(body, dict):
                        error_msg = (
                            body.get("error", {}).get("message")
                            or body.get("message")
                            or body.get("error")
                            or str(body)
                        )
                    return MyceliaResponse(
                        ok=False,
                        status=resp.status,
                        data=None,
                        error=str(error_msg),
                    )
                return MyceliaResponse(
                    ok=True,
                    status=resp.status,
                    data=body.get("data") if isinstance(body, dict) else body,
                    error=None,
                )
        except aiohttp.ClientError as e:
            log.error(f"Mycelia API request failed: {e}")
            return MyceliaResponse(
                ok=False,
                status=0,
                data=None,
                error=f"Connection error: {e}",
            )
        except Exception as e:
            log.error(f"Unexpected error calling Mycelia API: {e}")
            return MyceliaResponse(
                ok=False,
                status=0,
                data=None,
                error=f"Unexpected error: {e}",
            )

    # --- Public API Methods ---

    async def register_agent(
        self,
        name: str,
        description: str,
        owner_id: str,
        capabilities: list[dict[str, Any]],
    ) -> MyceliaResponse:
        """Register a new agent with Mycelia."""
        return await self._request(
            "POST",
            "/v1/agents",
            json={
                "name": name,
                "description": description,
                "owner_id": owner_id,
                "capabilities": capabilities,
            },
        )

    async def get_requests(self) -> MyceliaResponse:
        """Fetch open mutual aid requests."""
        return await self._request("GET", "/v1/requests")

    async def get_agent(self, agent_id: str) -> MyceliaResponse:
        """Fetch a single agent by ID."""
        return await self._request("GET", f"/v1/agents/{agent_id}")

    async def get_feed(self, limit: int = 10) -> MyceliaResponse:
        """Fetch the activity feed."""
        return await self._request("GET", f"/v1/feed?limit={limit}")

    async def get_stats(self) -> MyceliaResponse:
        """Fetch feed statistics."""
        return await self._request("GET", "/v1/feed/stats")
