// =====================
// IMPORTS
// =====================
require('dotenv').config();
const { Client, GatewayIntentBits, AuditLogEvent, PermissionsBitField, REST, Routes } = require('discord.js');
const mongoose = require('mongoose');
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;

// =====================
// CONFIG
// =====================
const PREFIX = process.env.PREFIX || "$";

// =====================
// DATABASE
// =====================
mongoose.connect(process.env.MONGO_URI)
.then(()=>console.log("MongoDB Connected"))
.catch(err=>console.log(err));

const guildSchema = new mongoose.Schema({
  guildId: String,
  whitelist: { type: [String], default: [] },
  ownerWhitelist: { type: [String], default: [] },
  logs: String,
  premium: {
    enabled: Boolean,
    expires: Number
  },
  raid: {
    joins: { type: Number, default: 0 },
    lastJoin: Number
  }
});

const Guild = mongoose.model("Guild", guildSchema);

// =====================
// BOT SETUP
// =====================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages
  ]
});

// =====================
// DASHBOARD (OAuth)
// =====================
const app = express();

app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false
}));

app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((u, done)=>done(null,u));
passport.deserializeUser((obj, done)=>done(null,obj));

passport.use(new DiscordStrategy({
  clientID: process.env.CLIENT_ID,
  clientSecret: process.env.CLIENT_SECRET,
  callbackURL: "/callback",
  scope: ["identify","guilds"]
},
(accessToken, refreshToken, profile, done)=>{
  return done(null, profile);
}));

app.get("/", (req,res)=>{
  res.send(`<a href="/login">Login with Discord</a>`);
});

app.get("/login", passport.authenticate("discord"));

app.get("/callback",
  passport.authenticate("discord", { failureRedirect: "/" }),
  (req,res)=> res.send(`Logged in as ${req.user.username}`)
);

// =====================
// HELPER FUNCTIONS
// =====================
async function punish(member) {
  try {
    await member.roles.set([]);
  } catch {}
}

async function isWhitelisted(guildId, userId) {
  const data = await Guild.findOne({ guildId });
  if (!data) return false;
  return data.whitelist.includes(userId) || data.ownerWhitelist.includes(userId);
}

// =====================
// RAID DETECTION
// =====================
client.on("guildMemberAdd", async member => {
  const data = await Guild.findOneAndUpdate(
    { guildId: member.guild.id },
    { $inc: { "raid.joins": 1 }, $set: { "raid.lastJoin": Date.now() } },
    { upsert: true, new: true }
  );

  if (data.raid.joins > 5) {
    member.guild.channels.cache.forEach(c => {
      c.permissionOverwrites.edit(member.guild.roles.everyone, {
        SendMessages: false
      }).catch(()=>{});
    });
  }

  setTimeout(async ()=>{
    const reset = await Guild.findOne({ guildId: member.guild.id });
    if (reset) {
      reset.raid.joins = 0;
      await reset.save();
    }
  }, 10000);
});

// =====================
// ANTI NUKE EVENTS
// =====================
async function checkAudit(guild, type) {
  const logs = await guild.fetchAuditLogs({ type, limit: 1 });
  return logs.entries.first();
}

// Channel Delete
client.on("channelDelete", async channel => {
  const entry = await checkAudit(channel.guild, AuditLogEvent.ChannelDelete);
  if (!entry) return;

  const user = entry.executor;
  if (await isWhitelisted(channel.guild.id, user.id)) return;

  const member = await channel.guild.members.fetch(user.id);
  punish(member);

  // recovery
  channel.guild.channels.create({
    name: channel.name,
    type: channel.type
  });
});

// Role Delete
client.on("roleDelete", async role => {
  const entry = await checkAudit(role.guild, AuditLogEvent.RoleDelete);
  if (!entry) return;

  const user = entry.executor;
  if (await isWhitelisted(role.guild.id, user.id)) return;

  const member = await role.guild.members.fetch(user.id);
  punish(member);

  role.guild.roles.create({
    name: role.name,
    permissions: role.permissions
  });
});

// Bot Add
client.on("guildMemberAdd", async member => {
  if (!member.user.bot) return;

  const entry = await checkAudit(member.guild, AuditLogEvent.BotAdd);
  if (!entry) return;

  const user = entry.executor;
  if (await isWhitelisted(member.guild.id, user.id)) return;

  await member.kick();
});

// =====================
// COMMAND HANDLER
// =====================
client.on("messageCreate", async message => {
  if (!message.content.startsWith(PREFIX) || message.author.bot) return;

  const args = message.content.slice(PREFIX.length).trim().split(/ +/);
  const cmd = args.shift().toLowerCase();

  // WHITELIST
  if (cmd === "wl") {
    const user = message.mentions.users.first();
    if (!user) return message.reply("Mention user");

    await Guild.findOneAndUpdate(
      { guildId: message.guild.id },
      { $addToSet: { whitelist: user.id } },
      { upsert: true }
    );

    message.reply("User whitelisted");
  }

  // LOG CHANNEL
  if (cmd === "setlogs") {
    await Guild.findOneAndUpdate(
      { guildId: message.guild.id },
      { logs: message.channel.id },
      { upsert: true }
    );

    message.reply("Logs set");
  }

  // PREMIUM
  if (cmd === "addpremium") {
    const days = parseInt(args[0]) || 30;

    await Guild.findOneAndUpdate(
      { guildId: message.guild.id },
      {
        premium: {
          enabled: true,
          expires: Date.now() + days * 86400000
        }
      },
      { upsert: true }
    );

    message.reply("Premium activated");
  }
});

// =====================
// SLASH COMMANDS
// =====================
const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);

(async () => {
  await rest.put(
    Routes.applicationCommands(process.env.CLIENT_ID),
    {
      body: [
        { name: "ping", description: "Ping test" },
        { name: "lockdown", description: "Lock server" }
      ]
    }
  );
})();

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "ping") {
    return interaction.reply("Pong!");
  }

  if (interaction.commandName === "lockdown") {
    interaction.guild.channels.cache.forEach(c => {
      c.permissionOverwrites.edit(interaction.guild.roles.everyone, {
        SendMessages: false
      }).catch(()=>{});
    });

    interaction.reply("Server locked");
  }
});

// =====================
// START EVERYTHING
// =====================
const PORT = process.env.PORT || 3000;

app.listen(PORT, ()=>console.log("Dashboard running"));
client.login(process.env.TOKEN);


import pg from 'pg';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../src/utils/logger.js';
import { EXPECTED_SCHEMA_LABEL, EXPECTED_SCHEMA_VERSION } from '../src/config/schemaVersion.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.POSTGRES_URL,
  ssl: false,
});

const migrationTable = process.env.POSTGRES_MIGRATION_TABLE || 'schema_migrations';
const migrationTablePattern = /^[a-z_][a-z0-9_]*$/;

if (!migrationTablePattern.test(migrationTable)) {
  throw new Error(`Invalid migration table name: ${migrationTable}`);
}

const ensureMigrationLedger = async (client) => {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${migrationTable} (
      version INTEGER PRIMARY KEY,
      label VARCHAR(255) NOT NULL,
      applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
};

const recordSchemaVersion = async (client) => {
  await ensureMigrationLedger(client);
  await client.query(
    `INSERT INTO ${migrationTable} (version, label)
     VALUES ($1, $2)
     ON CONFLICT (version)
     DO UPDATE SET label = EXCLUDED.label, applied_at = CURRENT_TIMESTAMP`,
    [EXPECTED_SCHEMA_VERSION, EXPECTED_SCHEMA_LABEL]
  );
};

const getCurrentSchemaVersion = async (client) => {
  await ensureMigrationLedger(client);
  const result = await client.query(
    `SELECT version, label, applied_at FROM ${migrationTable} ORDER BY version DESC LIMIT 1`
  );

  if (result.rows.length === 0) {
    return null;
  }

  return result.rows[0];
};

const createTables = async (client) => {
  logger.info('📊 Creating database tables...');

  const tables = [
    
    `CREATE TABLE IF NOT EXISTS guild_configs (
      guild_id VARCHAR(255) PRIMARY KEY,
      prefix VARCHAR(10) DEFAULT '!',
      welcome_channel VARCHAR(255),
      welcome_message TEXT,
      welcome_enabled BOOLEAN DEFAULT false,
      autorole_ids TEXT[] DEFAULT '{}',
      modlog_channel VARCHAR(255),
      settings JSONB DEFAULT '{}',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,

    
    `CREATE TABLE IF NOT EXISTS user_levels (
      id SERIAL PRIMARY KEY,
      user_id VARCHAR(255) NOT NULL,
      guild_id VARCHAR(255) NOT NULL,
      xp BIGINT DEFAULT 0,
      level INT DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, guild_id)
    )`,

    
    `CREATE TABLE IF NOT EXISTS user_economy (
      id SERIAL PRIMARY KEY,
      user_id VARCHAR(255) NOT NULL,
      guild_id VARCHAR(255) NOT NULL,
      balance BIGINT DEFAULT 0,
      bank BIGINT DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, guild_id)
    )`,

    
    `CREATE TABLE IF NOT EXISTS birthdays (
      id SERIAL PRIMARY KEY,
      user_id VARCHAR(255) NOT NULL,
      guild_id VARCHAR(255) NOT NULL,
      month INT NOT NULL,
      day INT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, guild_id)
    )`,

    
    `CREATE TABLE IF NOT EXISTS tickets (
      id SERIAL PRIMARY KEY,
      ticket_id VARCHAR(255) UNIQUE NOT NULL,
      guild_id VARCHAR(255) NOT NULL,
      user_id VARCHAR(255) NOT NULL,
      channel_id VARCHAR(255) NOT NULL,
      status VARCHAR(50) DEFAULT 'open',
      subject TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      closed_at TIMESTAMP
    )`,

    
    `CREATE TABLE IF NOT EXISTS giveaways (
      id SERIAL PRIMARY KEY,
      giveaway_id VARCHAR(255) UNIQUE NOT NULL,
      guild_id VARCHAR(255) NOT NULL,
      channel_id VARCHAR(255) NOT NULL,
      message_id VARCHAR(255) NOT NULL,
      prize TEXT NOT NULL,
      winners_count INT DEFAULT 1,
      ended BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      ends_at TIMESTAMP NOT NULL
    )`,

    
    `CREATE TABLE IF NOT EXISTS giveaway_entries (
      id SERIAL PRIMARY KEY,
      giveaway_id INTEGER NOT NULL,
      user_id VARCHAR(255) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(giveaway_id, user_id),
      FOREIGN KEY(giveaway_id) REFERENCES giveaways(id) ON DELETE CASCADE
    )`,

    
    `CREATE TABLE IF NOT EXISTS reaction_roles (
      id SERIAL PRIMARY KEY,
      guild_id VARCHAR(255) NOT NULL,
      channel_id VARCHAR(255) NOT NULL,
      message_id VARCHAR(255) NOT NULL,
      emoji VARCHAR(255) NOT NULL,
      role_id VARCHAR(255) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(message_id, emoji)
    )`,

    
    `CREATE TABLE IF NOT EXISTS welcome_system (
      id SERIAL PRIMARY KEY,
      guild_id VARCHAR(255) UNIQUE NOT NULL,
      channel_id VARCHAR(255),
      message TEXT,
      enabled BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,

    
    `CREATE TABLE IF NOT EXISTS counters (
      id SERIAL PRIMARY KEY,
      guild_id VARCHAR(255) UNIQUE NOT NULL,
      user_count_channel VARCHAR(255),
      bot_count_channel VARCHAR(255),
      online_count_channel VARCHAR(255),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,

    
    `CREATE TABLE IF NOT EXISTS audit_logs (
      id SERIAL PRIMARY KEY,
      guild_id VARCHAR(255) NOT NULL,
      user_id VARCHAR(255),
      action VARCHAR(255) NOT NULL,
      target_id VARCHAR(255),
      reason TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`
  ];

  for (const table of tables) {
    try {
      await client.query(table);
    } catch (error) {
      logger.error(`❌ Error creating table: ${error.message}`);
      throw error;
    }
  }

  logger.info('✅ All tables created successfully');
};

const createIndexes = async (client) => {
  logger.info('📈 Creating indexes...');

  const indexes = [
    'CREATE INDEX IF NOT EXISTS idx_user_levels_guild ON user_levels(guild_id)',
    'CREATE INDEX IF NOT EXISTS idx_user_economy_guild ON user_economy(guild_id)',
    'CREATE INDEX IF NOT EXISTS idx_tickets_guild ON tickets(guild_id)',
    'CREATE INDEX IF NOT EXISTS idx_giveaways_guild ON giveaways(guild_id)',
    'CREATE INDEX IF NOT EXISTS idx_audit_logs_guild ON audit_logs(guild_id)',
  ];

  for (const index of indexes) {
    try {
      await client.query(index);
    } catch (error) {
      logger.error(`❌ Error creating index: ${error.message}`);
      throw error;
    }
  }

  logger.info('✅ All indexes created successfully');
};

const createTriggers = async (client) => {
  logger.info('⏰ Setting up automatic timestamps...');

  const triggers = [
    {
      table: 'guild_configs',
      name: 'update_guild_configs_timestamp'
    },
    {
      table: 'user_levels',
      name: 'update_user_levels_timestamp'
    },
    {
      table: 'user_economy',
      name: 'update_user_economy_timestamp'
    },
    {
      table: 'birthdays',
      name: 'update_birthdays_timestamp'
    },
    {
      table: 'tickets',
      name: 'update_tickets_timestamp'
    },
    {
      table: 'giveaways',
      name: 'update_giveaways_timestamp'
    },
    {
      table: 'reaction_roles',
      name: 'update_reaction_roles_timestamp'
    },
    {
      table: 'welcome_system',
      name: 'update_welcome_system_timestamp'
    },
    {
      table: 'counters',
      name: 'update_counters_timestamp'
    }
  ];

  for (const { table, name } of triggers) {
    try {
      
      await client.query(`
        CREATE OR REPLACE FUNCTION update_timestamp_${table}()
        RETURNS TRIGGER AS $$
        BEGIN
          NEW.updated_at = CURRENT_TIMESTAMP;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
      `);

      
      await client.query(`
        DROP TRIGGER IF EXISTS ${name} ON ${table};
        CREATE TRIGGER ${name}
        BEFORE UPDATE ON ${table}
        FOR EACH ROW
        EXECUTE FUNCTION update_timestamp_${table}();
      `);
    } catch (error) {
      logger.error(`❌ Error creating trigger for ${table}: ${error.message}`);
      throw error;
    }
  }

  logger.info('✅ All triggers created successfully');
};

const migrate = async () => {
  const client = await pool.connect();

  try {
    logger.info('🚀 Starting database migration...');

    await createTables(client);
    await createIndexes(client);
    await createTriggers(client);
    await recordSchemaVersion(client);

    logger.info('✨ Migration completed successfully!');
    logger.info(`📌 Schema version recorded: v${EXPECTED_SCHEMA_VERSION} (${EXPECTED_SCHEMA_LABEL})`);
    logger.info('📚 Your database is now ready for TitanBot.');
  } catch (error) {
    logger.error('❌ Migration failed:', error);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
};

const checkMigrationVersion = async () => {
  const client = await pool.connect();

  try {
    const current = await getCurrentSchemaVersion(client);

    if (!current) {
      logger.error(`❌ No schema version found in ${migrationTable}. Expected v${EXPECTED_SCHEMA_VERSION}.`);
      process.exit(1);
    }

    const currentVersion = Number(current.version);
    if (currentVersion !== EXPECTED_SCHEMA_VERSION) {
      logger.error(
        `❌ Schema drift detected. Expected v${EXPECTED_SCHEMA_VERSION}, found v${currentVersion}.`
      );
      process.exit(1);
    }

    logger.info(
      `✅ Schema version check passed (v${currentVersion}, label: ${current.label}).`
    );
  } catch (error) {
    logger.error('❌ Migration check failed:', error);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
};

const printMigrationStatus = async () => {
  const client = await pool.connect();

  try {
    const current = await getCurrentSchemaVersion(client);
    if (!current) {
      logger.info(`ℹ️ No schema version recorded yet. Expected v${EXPECTED_SCHEMA_VERSION}.`);
      return;
    }

    logger.info(`📌 Current schema version: v${current.version}`);
    logger.info(`🏷️ Label: ${current.label}`);
    logger.info(`🕒 Applied at: ${current.applied_at}`);
    logger.info(`🎯 Expected: v${EXPECTED_SCHEMA_VERSION} (${EXPECTED_SCHEMA_LABEL})`);
  } catch (error) {
    logger.error('❌ Migration status failed:', error);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
};

const command = process.argv[2] || 'apply';

if (command === 'apply') {
  migrate();
} else if (command === 'check') {
  checkMigrationVersion();
} else if (command === 'status') {
  printMigrationStatus();
} else {
  logger.error(`Unknown command: ${command}. Use one of: apply, check, status`);
  process.exit(1);
}
