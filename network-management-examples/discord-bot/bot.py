"""Minimal Mycelia Discord bot -- loads the mycelia cog and syncs commands."""

import logging
import os

import discord
from discord.ext import commands
from dotenv import load_dotenv

load_dotenv()
logging.basicConfig(level=logging.INFO)

bot = commands.Bot(command_prefix="!", intents=discord.Intents.default())


@bot.event
async def on_ready():
    await bot.load_extension("cogs.mycelia")
    synced = await bot.tree.sync()
    logging.info(f"Mycelia bot ready -- {len(synced)} commands synced")


bot.run(os.environ["DISCORD_TOKEN"])
