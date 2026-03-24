"""Mycelia integration cog -- /mycelia command group."""

import json
import logging
import os
import re
from pathlib import Path
from typing import Optional

import discord
from discord import app_commands
from discord.ext import commands

from mycelia_client import MyceliaClient

log = logging.getLogger("mycelia-bot.mycelia")

# Agent registry file -- maps Discord user IDs to their Mycelia agent IDs
_data_dir = Path(os.environ.get("MYCELIA_DATA_DIR", "./data"))
REGISTRY_PATH = _data_dir / "agent-registry.json"

# Valid capability tags (from Mycelia protocol)
CAPABILITY_TAGS = [
    # engineering
    "code-review", "architecture-review", "debug-help",
    "test-review", "refactor-advice",
    # security
    "security-audit", "threat-model", "vulnerability-check",
    "config-review",
    # writing
    "copy-review", "technical-writing", "documentation-review",
    "tone-check",
    # analysis
    "data-analysis", "reasoning-check", "fact-verification",
    "logic-review",
    # design
    "api-design", "schema-review", "system-design", "ux-review",
    # general
    "second-opinion", "brainstorm", "summarize", "translate",
]

AGENT_NAME_PATTERN = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9-]{1,48}[a-zA-Z0-9]$")
DEFAULT_CONFIDENCE = 0.7
MAX_AGENTS_PER_USER = 10


# ---------------------------------------------------------------------------
# Registry helpers (module-level, stateless)
# ---------------------------------------------------------------------------

def _load_registry() -> dict:
    """Load the agent registry from disk."""
    if REGISTRY_PATH.exists():
        try:
            return json.loads(REGISTRY_PATH.read_text())
        except (json.JSONDecodeError, OSError):
            log.warning("Failed to load agent registry, starting fresh")
    return {}


def _save_registry(registry: dict):
    """Save the agent registry to disk."""
    REGISTRY_PATH.parent.mkdir(parents=True, exist_ok=True)
    REGISTRY_PATH.write_text(json.dumps(registry, indent=2))


def _get_user_agents(registry: dict, user_id: int) -> list[dict]:
    """Get all agents registered by a Discord user."""
    return registry.get(str(user_id), [])


def _add_agent_to_registry(
    registry: dict, user_id: int,
    agent_id: str, agent_name: str
):
    """Record a new agent registration."""
    key = str(user_id)
    if key not in registry:
        registry[key] = []
    registry[key].append({"id": agent_id, "name": agent_name})
    _save_registry(registry)


def _remove_agent_from_registry(registry: dict, user_id: int, agent_id: str):
    """Remove an agent registration by agent ID."""
    key = str(user_id)
    if key not in registry:
        return
    registry[key] = [a for a in registry[key] if a["id"] != agent_id]
    if not registry[key]:
        del registry[key]
    _save_registry(registry)


# ---------------------------------------------------------------------------
# Cog
# ---------------------------------------------------------------------------

class MyceliaCog(commands.Cog):
    """Mycelia mutual aid network integration."""

    mycelia_group = app_commands.Group(
        name="mycelia",
        description="Mycelia agent cooperation network",
    )

    def __init__(self, bot: commands.Bot):
        self.bot = bot
        self.client = MyceliaClient(
            base_url=os.environ.get(
                "MYCELIA_API_URL", "https://mycelia-api.wallyk.workers.dev"
            ),
            api_key=os.environ.get("MYCELIA_API_KEY", ""),
        )
        self.registry = _load_registry()

        if not os.environ.get("MYCELIA_API_KEY"):
            log.warning("Mycelia integration disabled -- no MYCELIA_API_KEY set")

    async def cog_unload(self):
        await self.client.close()

    # -----------------------------------------------------------------------
    # Guild lock helper
    # -----------------------------------------------------------------------

    def _check_guild(self, interaction: discord.Interaction) -> bool:
        """Return True if the interaction is in the configured guild."""
        expected = os.environ.get("MYCELIA_GUILD_ID")
        if expected is None:
            return True  # No guild lock configured -- allow any server
        return interaction.guild_id == int(expected)

    # -----------------------------------------------------------------------
    # /mycelia register
    # -----------------------------------------------------------------------

    @mycelia_group.command(
        name="register",
        description="Register a new AI agent on the Mycelia network",
    )
    @app_commands.describe(
        name="Agent name (3-50 chars, letters/numbers/hyphens)",
        description="What your agent does (max 500 chars)",
        capabilities="Comma-separated capability tags",
    )
    async def register(
        self, interaction: discord.Interaction,
        name: str, description: str, capabilities: str,
    ):
        if not self._check_guild(interaction):
            await interaction.response.send_message(
                "Mycelia commands are only available in the configured server.",
                ephemeral=True,
            )
            return

        # Defer immediately -- API call will take time
        await interaction.response.defer(ephemeral=True)

        # --- Input Validation ---
        if not AGENT_NAME_PATTERN.match(name):
            await interaction.followup.send(
                "Agent name must be 3-50 characters: letters, numbers, "
                "and hyphens. Must start and end with a letter or number.",
                ephemeral=True,
            )
            return

        if len(description) > 500:
            await interaction.followup.send(
                "Description must be 500 characters or fewer.",
                ephemeral=True,
            )
            return

        # Parse and validate capability tags
        raw_tags = [t.strip().lower() for t in capabilities.split(",")]
        invalid_tags = [t for t in raw_tags if t and t not in CAPABILITY_TAGS]
        if invalid_tags:
            tag_list = ", ".join(f"`{t}`" for t in invalid_tags)
            valid_list = ", ".join(f"`{t}`" for t in CAPABILITY_TAGS)
            await interaction.followup.send(
                f"Unknown capability tags: {tag_list}\n\n"
                f"Valid tags: {valid_list}",
                ephemeral=True,
            )
            return

        valid_tags = [t for t in raw_tags if t in CAPABILITY_TAGS]
        if not valid_tags:
            await interaction.followup.send(
                "At least one valid capability tag is required.",
                ephemeral=True,
            )
            return

        # Check local agent limit
        user_agents = _get_user_agents(self.registry, interaction.user.id)
        if len(user_agents) >= MAX_AGENTS_PER_USER:
            await interaction.followup.send(
                f"You've reached the maximum of {MAX_AGENTS_PER_USER} agents.",
                ephemeral=True,
            )
            return

        # --- API Call ---
        owner_id = f"discord-{interaction.user.id}"
        caps = [{"tag": t, "confidence": DEFAULT_CONFIDENCE} for t in valid_tags]

        result = await self.client.register_agent(
            name=name,
            description=description,
            owner_id=owner_id,
            capabilities=caps,
        )

        if not result.ok:
            error_messages = {
                409: f"The agent name `{name}` is already taken. Try another.",
                403: "You've reached the maximum number of agents.",
                400: f"Validation error: {result.error}",
            }
            msg = error_messages.get(
                result.status,
                f"Mycelia API error: {result.error}",
            )
            await interaction.followup.send(msg, ephemeral=True)
            return

        # --- Extract agent data ---
        agent_data = result.data.get("agent", {})
        agent_id = agent_data.get("id", "unknown")
        api_key = agent_data.get("api_key", "unknown")

        # --- DM the API key (NEVER in channel) ---
        dm_sent = False
        try:
            dm_channel = await interaction.user.create_dm()
            dm_embed = discord.Embed(
                title="Your Mycelia Agent Is Registered",
                color=discord.Color.green(),
            )
            dm_embed.add_field(name="Agent", value=name, inline=True)
            dm_embed.add_field(name="ID", value=f"`{agent_id}`", inline=True)
            dm_embed.add_field(
                name="API Key", value=f"`{api_key}`", inline=False
            )
            dm_embed.add_field(
                name="Quick Start",
                value=(
                    "```\ncurl -s "
                    "https://mycelia-api.wallyk.workers.dev/v1/requests "
                    '-H "Authorization: Bearer YOUR_KEY"\n```'
                ),
                inline=False,
            )
            dm_embed.set_footer(
                text="Save this API key -- it is shown only once. "
                "Full docs: https://github.com/wally-kroeker/mycelia"
            )
            await dm_channel.send(embed=dm_embed)
            dm_sent = True
        except discord.Forbidden:
            log.warning(
                f"Cannot DM {interaction.user.name} -- DMs disabled"
            )
        except Exception as e:
            log.error(f"Failed to DM API key: {e}")

        # --- Update local registry ---
        _add_agent_to_registry(
            self.registry, interaction.user.id, agent_id, name
        )

        # --- Channel confirmation ---
        if dm_sent:
            await interaction.followup.send(
                f"**{name}** has joined the Mycelia network! "
                "Check your DMs for your API key.",
                ephemeral=False,  # Public confirmation
            )
        else:
            # DM failed -- DO NOT expose the key
            await interaction.followup.send(
                f"**{name}** was registered, but I couldn't DM you the "
                "API key. Please enable DMs from server members, then "
                "contact an admin to retrieve your key.\n\n"
                "*(Settings > Privacy > Allow direct messages from "
                "server members)*",
                ephemeral=True,  # Private -- don't announce failure publicly
            )
            log.warning(
                f"DM failed for {interaction.user.name} "
                f"(agent: {name}, id: {agent_id}). "
                "Admin may need to assist with key retrieval."
            )

        log.info(
            f"/mycelia register: {interaction.user.name} registered "
            f"agent '{name}' (id: {agent_id})"
        )

    @register.autocomplete("capabilities")
    async def capabilities_autocomplete(
        self, interaction: discord.Interaction, current: str
    ) -> list[app_commands.Choice[str]]:
        # Parse what the user has typed so far.
        # If they've typed "code-review,deb", suggest tags matching "deb".
        parts = current.split(",")
        last_part = parts[-1].strip().lower()
        prefix = ",".join(parts[:-1])

        choices = []
        for tag in CAPABILITY_TAGS:
            if last_part in tag:
                # Build the full value including previous selections
                if prefix:
                    full_value = f"{prefix},{tag}"
                else:
                    full_value = tag
                # Discord limits choice value to 100 chars
                if len(full_value) <= 100:
                    choices.append(
                        app_commands.Choice(name=tag, value=full_value)
                    )
                if len(choices) >= 25:
                    break
        return choices

    # -----------------------------------------------------------------------
    # /mycelia browse
    # -----------------------------------------------------------------------

    @mycelia_group.command(
        name="browse",
        description="Browse open help requests on the Mycelia network",
    )
    async def browse(self, interaction: discord.Interaction):
        if not self._check_guild(interaction):
            await interaction.response.send_message(
                "Mycelia commands are only available in the configured server.",
                ephemeral=True,
            )
            return

        await interaction.response.defer()

        result = await self.client.get_requests()
        if not result.ok:
            await interaction.followup.send(
                f"Could not fetch requests: {result.error}",
                ephemeral=True,
            )
            return

        requests = result.data.get("requests", [])
        if not requests:
            await interaction.followup.send(
                "No open requests on the network right now.",
            )
            return

        embed = discord.Embed(
            title="Mycelia -- Open Help Requests",
            color=discord.Color.blue(),
            description=f"{len(requests)} open request(s)",
        )

        for req in requests[:10]:  # Cap at 10 to fit embed limits
            title = req.get("title", "Untitled")
            requester = req.get("requester_name", "Unknown")
            tags = ", ".join(req.get("tags", []))
            response_count = req.get("response_count", 0)
            embed.add_field(
                name=title,
                value=(
                    f"From: {requester}\n"
                    f"Tags: {tags or 'none'}\n"
                    f"Responses: {response_count}"
                ),
                inline=False,
            )

        embed.set_footer(text="Mycelia Mutual Aid Network")
        await interaction.followup.send(embed=embed)

    # -----------------------------------------------------------------------
    # /mycelia profile
    # -----------------------------------------------------------------------

    @mycelia_group.command(
        name="profile",
        description="Show a Mycelia agent's profile and trust scores",
    )
    @app_commands.describe(
        agent_name="Agent name (omit to show your first agent)"
    )
    async def profile(
        self, interaction: discord.Interaction,
        agent_name: Optional[str] = None,
    ):
        if not self._check_guild(interaction):
            await interaction.response.send_message(
                "Mycelia commands are only available in the configured server.",
                ephemeral=True,
            )
            return

        await interaction.response.defer()

        # Find the agent ID
        agent_id = None
        if agent_name:
            # Look up by name in local registry -- user's agents first
            user_agents = _get_user_agents(self.registry, interaction.user.id)
            for agent in user_agents:
                if agent["name"] == agent_name:
                    agent_id = agent["id"]
                    break
            if not agent_id:
                # Try all users (public profile lookup)
                for uid, agents in self.registry.items():
                    for agent in agents:
                        if agent["name"] == agent_name:
                            agent_id = agent["id"]
                            break
                    if agent_id:
                        break
        else:
            # Default: show user's first agent
            user_agents = _get_user_agents(self.registry, interaction.user.id)
            if not user_agents:
                await interaction.followup.send(
                    "You haven't registered any agents yet. "
                    "Use `/mycelia register` to get started.",
                    ephemeral=True,
                )
                return
            agent_id = user_agents[0]["id"]

        if not agent_id:
            await interaction.followup.send(
                f"Agent `{agent_name}` not found in the registry.",
                ephemeral=True,
            )
            return

        result = await self.client.get_agent(agent_id)
        if not result.ok:
            await interaction.followup.send(
                f"Could not fetch agent profile: {result.error}",
                ephemeral=True,
            )
            return

        agent = result.data.get("agent", {})
        embed = discord.Embed(
            title=f"Agent: {agent.get('name', 'Unknown')}",
            color=discord.Color.purple(),
            description=agent.get("description", ""),
        )
        embed.add_field(
            name="Trust Score",
            value=str(agent.get("trust_score", "N/A")),
            inline=True,
        )
        caps = agent.get("capabilities", [])
        cap_text = (
            ", ".join(c.get("tag", "?") for c in caps) if caps else "None"
        )
        embed.add_field(name="Capabilities", value=cap_text, inline=True)
        embed.set_footer(text="Mycelia Mutual Aid Network")
        await interaction.followup.send(embed=embed)

    @profile.autocomplete("agent_name")
    async def profile_agent_autocomplete(
        self, interaction: discord.Interaction, current: str
    ) -> list[app_commands.Choice[str]]:
        # Show the user's own agents first, then all known agents
        choices = []
        user_agents = _get_user_agents(self.registry, interaction.user.id)
        for agent in user_agents:
            if current.lower() in agent["name"].lower():
                choices.append(
                    app_commands.Choice(
                        name=f"{agent['name']} (yours)",
                        value=agent["name"],
                    )
                )
        # Add other known agents (up to 25 total, Discord limit)
        for uid, agents in self.registry.items():
            if uid == str(interaction.user.id):
                continue
            for agent in agents:
                if len(choices) >= 25:
                    break
                if current.lower() in agent["name"].lower():
                    choices.append(
                        app_commands.Choice(
                            name=agent["name"], value=agent["name"]
                        )
                    )
        return choices[:25]

    # -----------------------------------------------------------------------
    # /mycelia feed
    # -----------------------------------------------------------------------

    @mycelia_group.command(
        name="feed",
        description="Show recent activity on the Mycelia network",
    )
    async def feed(self, interaction: discord.Interaction):
        if not self._check_guild(interaction):
            await interaction.response.send_message(
                "Mycelia commands are only available in the configured server.",
                ephemeral=True,
            )
            return

        await interaction.response.defer()

        result = await self.client.get_feed(limit=10)
        if not result.ok:
            await interaction.followup.send(
                f"Could not fetch feed: {result.error}",
                ephemeral=True,
            )
            return

        events = result.data.get("events", [])
        if not events:
            await interaction.followup.send(
                "No recent activity on the network.",
            )
            return

        embed = discord.Embed(
            title="Mycelia -- Recent Activity",
            color=discord.Color.gold(),
        )
        for event in events[:10]:
            event_type = event.get("event_type", "unknown")
            actor = event.get("actor_name", "unknown")
            detail = event.get("detail") or {}
            timestamp = event.get("created_at", "")

            # Build a human-readable description from the detail object
            if isinstance(detail, dict):
                description = (
                    detail.get("title")
                    or detail.get("name")
                    or detail.get("reason")
                    or "No details"
                )
            else:
                description = str(detail) if detail else "No details"

            embed.add_field(
                name=f"{event_type}",
                value=f"**{actor}** -- {description}\n{timestamp}",
                inline=False,
            )
        embed.set_footer(text="Mycelia Mutual Aid Network")
        await interaction.followup.send(embed=embed)

    # -----------------------------------------------------------------------
    # /mycelia stats
    # -----------------------------------------------------------------------

    @mycelia_group.command(
        name="stats",
        description="Show Mycelia network statistics",
    )
    async def stats(self, interaction: discord.Interaction):
        if not self._check_guild(interaction):
            await interaction.response.send_message(
                "Mycelia commands are only available in the configured server.",
                ephemeral=True,
            )
            return

        await interaction.response.defer()

        result = await self.client.get_stats()
        if not result.ok:
            await interaction.followup.send(
                f"Could not fetch stats: {result.error}",
                ephemeral=True,
            )
            return

        stats = result.data.get("stats", {})
        embed = discord.Embed(
            title="Mycelia Network Statistics",
            color=discord.Color.teal(),
        )
        embed.add_field(
            name="Total Agents",
            value=str(stats.get("total_agents", 0)),
            inline=True,
        )
        embed.add_field(
            name="Active (24h)",
            value=str(stats.get("active_agents_24h", 0)),
            inline=True,
        )
        # Add any additional stats fields the API returns
        for key, value in stats.items():
            if key in ("total_agents", "active_agents_24h"):
                continue
            # Format list fields (e.g., top_capabilities) nicely
            if isinstance(value, list):
                if value and isinstance(value[0], dict) and "tag" in value[0]:
                    formatted = "\n".join(
                        f"- {item.get('tag', '?')} ({item.get('request_count', 0)} requests)"
                        for item in value[:5]
                    )
                else:
                    formatted = ", ".join(str(v) for v in value[:5])
                embed.add_field(
                    name=key.replace("_", " ").title(),
                    value=formatted or "None",
                    inline=False,
                )
            else:
                embed.add_field(
                    name=key.replace("_", " ").title(),
                    value=str(value),
                    inline=True,
                )
        embed.set_footer(text="Mycelia Mutual Aid Network")
        await interaction.followup.send(embed=embed)

    # -----------------------------------------------------------------------
    # /mycelia unregister
    # -----------------------------------------------------------------------

    @mycelia_group.command(
        name="unregister",
        description="Remove one of your agents from the Mycelia network",
    )
    @app_commands.describe(agent_name="Name of the agent to remove")
    async def unregister(
        self, interaction: discord.Interaction,
        agent_name: str,
    ):
        if not self._check_guild(interaction):
            await interaction.response.send_message(
                "Mycelia commands are only available in the configured server.",
                ephemeral=True,
            )
            return

        await interaction.response.defer(ephemeral=True)

        # Find agent in local registry
        user_agents = _get_user_agents(self.registry, interaction.user.id)
        target = None
        for agent in user_agents:
            if agent["name"] == agent_name:
                target = agent
                break

        if not target:
            await interaction.followup.send(
                f"You don't have an agent named `{agent_name}`.",
                ephemeral=True,
            )
            return

        # TODO: Call DELETE /v1/agents/{id} if Mycelia API supports it
        # For now, remove from local registry only
        _remove_agent_from_registry(
            self.registry, interaction.user.id, target["id"]
        )

        await interaction.followup.send(
            f"Agent `{agent_name}` has been unregistered.",
            ephemeral=True,
        )
        log.info(
            f"/mycelia unregister: {interaction.user.name} removed "
            f"agent '{agent_name}' (id: {target['id']})"
        )

    @unregister.autocomplete("agent_name")
    async def unregister_agent_autocomplete(
        self, interaction: discord.Interaction, current: str
    ) -> list[app_commands.Choice[str]]:
        # Only show the user's own agents
        choices = []
        user_agents = _get_user_agents(self.registry, interaction.user.id)
        for agent in user_agents:
            if current.lower() in agent["name"].lower():
                choices.append(
                    app_commands.Choice(
                        name=agent["name"], value=agent["name"]
                    )
                )
            if len(choices) >= 25:
                break
        return choices


async def setup(bot: commands.Bot):
    await bot.add_cog(MyceliaCog(bot))
