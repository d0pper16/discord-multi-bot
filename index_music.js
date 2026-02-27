const { Client, Collection, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } = require('discord.js');
const { Player } = require('discord-player');
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');
const { startKeepAlive, stopKeepAlive } = require('./keepalive');

dotenv.config();

// ============ CONFIG ============
const CONFIG = {
  token: process.env.DISCORD_TOKEN,
  prefix: process.env.PREFIX || '!',
  spotifyClientId: process.env.SPOTIFY_CLIENT_ID,
  spotifyClientSecret: process.env.SPOTIFY_CLIENT_SECRET,
  defaultVolume: 50,
  maxQueueSize: 100,
  author: 'made by - d0pper16',
  idleTimeout: 5 * 60 * 1000, // 5 menit dalam milliseconds
  prefixFile: path.join(__dirname, 'prefix-config.json')
};

// ============ PREFIX MANAGEMENT ============
function loadPrefix() {
  try {
    if (fs.existsSync(CONFIG.prefixFile)) {
      const data = fs.readFileSync(CONFIG.prefixFile, 'utf8');
      return JSON.parse(data).prefix || CONFIG.prefix;
    } else {
      // Jika file belum ada, buat file baru dengan prefix default
      console.log('📝 File prefix-config.json belum ada, membuat file baru...');
      savePrefix(CONFIG.prefix);
      return CONFIG.prefix;
    }
  } catch (error) {
    console.error('Error loading prefix:', error);
  }
  return CONFIG.prefix;
}

function savePrefix(newPrefix) {
  try {
    fs.writeFileSync(CONFIG.prefixFile, JSON.stringify({ prefix: newPrefix }, null, 2));
    CONFIG.prefix = newPrefix;
    console.log(`✅ Prefix berhasil disimpan: ${newPrefix}`);
    return true;
  } catch (error) {
    console.error('Error saving prefix:', error);
    return false;
  }
}

// Load prefix dari file saat startup
CONFIG.prefix = loadPrefix();

// ============ CLIENT SETUP ============
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildVoiceStates
  ]
});

// Initialize Player
const player = new Player(client, {
  ytdlOptions: {
    quality: 'highest',
    highWaterMark: 1 << 25
  }
});

client.commands = new Collection();
client.player = player;
client.config = CONFIG;
client.guildSettings = new Map();
client.idleTimers = new Map(); // Menyimpan idle timers untuk setiap guild

// ============ UTILITY FUNCTIONS ============
function formatDuration(ms) {
  const seconds = Math.floor((ms / 1000) % 60);
  const minutes = Math.floor((ms / (1000 * 60)) % 60);
  const hours = Math.floor((ms / (1000 * 60 * 60)) % 24);
  
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

// Fungsi untuk menghitung total durasi antrian
function calculateTotalDuration(queue) {
  let totalMs = queue.current.durationMS;
  queue.tracks.forEach(track => {
    totalMs += track.durationMS;
  });
  
  const hours = Math.floor(totalMs / (1000 * 60 * 60));
  const minutes = Math.floor((totalMs % (1000 * 60 * 60)) / (1000 * 60));
  
  if (hours > 0) {
    return `${hours} jam ${minutes} menit`;
  }
  return `${minutes} menit`;
}

// Fungsi untuk mengatur idle timeout
function setIdleTimeout(guild, queue) {
  // Clear idle timer yang sudah ada
  if (client.idleTimers.has(guild.id)) {
    clearTimeout(client.idleTimers.get(guild.id));
  }

  // Set idle timer baru
  const idleTimer = setTimeout(() => {
    const currentQueue = player.getQueue(guild);
    if (currentQueue && !currentQueue.playing) {
      const channel = currentQueue.metadata;
      if (channel) {
        channel.send({
          embeds: [{
            color: 0xFF0000,
            title: '🛑 Bot Disconnect',
            description: 'Bot disconnected karena tidak ada lagu yang diputar selama 5 menit',
            footer: { text: CONFIG.author }
          }]
        });
      }
      currentQueue.destroy();
    }
  }, CONFIG.idleTimeout);

  client.idleTimers.set(guild.id, idleTimer);
}

// Fungsi untuk clear idle timeout
function clearIdleTimeout(guild) {
  if (client.idleTimers.has(guild.id)) {
    clearTimeout(client.idleTimers.get(guild.id));
    client.idleTimers.delete(guild.id);
  }
}

// ============ COMMANDS ============

// CHANGE PREFIX Command (d0pper.changeprefix)
const changePrefixCommand = {
  name: 'd0pper.changeprefix',
  description: 'Ubah prefix bot (Admin only)',
  async execute(message, args, client) {
    // Cek apakah user memiliki permission Administrator
    if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return message.reply({
        embeds: [{
          color: 0xFF0000,
          title: '❌ Akses Ditolak',
          description: 'Hanya administrator yang dapat mengubah prefix',
          footer: { text: CONFIG.author }
        }]
      });
    }

    if (!args.length) {
      return message.reply({
        embeds: [{
          color: 0xFF0000,
          title: '❌ Error',
          description: `Penggunaan: \`d0pper.changeprefix <prefix baru>\`\nContoh: \`d0pper.changeprefix !\`\n\nPrefix saat ini: \`${CONFIG.prefix}\``,
          footer: { text: CONFIG.author }
        }]
      });
    }

    const newPrefix = args[0];

    if (newPrefix.length > 3) {
      return message.reply({
        embeds: [{
          color: 0xFF0000,
          title: '❌ Error',
          description: 'Prefix maksimal 3 karakter',
          footer: { text: CONFIG.author }
        }]
      });
    }

    const oldPrefix = CONFIG.prefix;
    
    if (savePrefix(newPrefix)) {
      return message.reply({
        embeds: [{
          color: 0x00FF00,
          title: '✅ Prefix Berhasil Diubah',
          description: `Prefix bot telah diubah oleh <@${message.author.id}>`,
          fields: [
            { name: 'Prefix Lama', value: `\`${oldPrefix}\``, inline: true },
            { name: 'Prefix Baru', value: `\`${newPrefix}\``, inline: true },
            { name: 'Info', value: `Prefix akan berlaku untuk semua perintah mulai sekarang`, inline: false }
          ],
          footer: { text: CONFIG.author }
        }]
      });
    } else {
      return message.reply({
        embeds: [{
          color: 0xFF0000,
          title: '❌ Error',
          description: 'Gagal menyimpan prefix baru',
          footer: { text: CONFIG.author }
        }]
      });
    }
  }
};

// JOIN Command
const joinCommand = {
  name: 'join',
  description: 'Join ke voice channel Anda',
  aliases: ['j'],
  async execute(message, args, client) {
    if (!message.member.voice.channel) {
      return message.reply({
        embeds: [{
          color: 0xFF0000,
          title: '❌ Error',
          description: 'Anda harus berada dalam voice channel terlebih dahulu!',
          footer: { text: CONFIG.author }
        }]
      });
    }

    try {
      const player = client.player;
      const existingQueue = player.getQueue(message.guild);

      // Cek apakah bot sudah ada di voice channel lain
      if (existingQueue && existingQueue.connection) {
        const botVoiceChannel = existingQueue.connection.channel;
        
        if (botVoiceChannel.id !== message.member.voice.channel.id) {
          return message.reply({
            embeds: [{
              color: 0xFF0000,
              title: '❌ Bot Sedang Digunakan',
              description: `Bot sedang digunakan di voice channel lain`,
              fields: [
                { name: 'Voice Channel Saat Ini', value: `<#${botVoiceChannel.id}>`, inline: false },
                { name: 'Informasi', value: `Tunggu hingga bot selesai atau stop pemutaran terlebih dahulu`, inline: false }
              ],
              footer: { text: CONFIG.author }
            }]
          });
        }

        // Bot sudah di voice channel yang sama
        return message.reply({
          embeds: [{
            color: 0xFF0000,
            title: '❌ Error',
            description: 'Bot sudah berada di voice channel ini',
            footer: { text: CONFIG.author }
          }]
        });
      }

      const queue = player.createQueue(message.guild, {
        metadata: message.channel,
        leaveOnEmpty: false,
        leaveOnEnd: false,
        leaveOnEmptyCooldown: 0
      });

      if (!queue.connection) {
        await queue.connect(message.member.voice.channel);
        
        // Set idle timeout untuk auto disconnect setelah 5 menit jika tidak ada lagu
        setIdleTimeout(message.guild, queue);

        return message.reply({
          embeds: [{
            color: 0x00FF00,
            title: '✅ Berhasil Join',
            description: `Bot berhasil join ke voice channel <#${message.member.voice.channel.id}>`,
            fields: [
              { name: 'Auto Disconnect', value: 'Bot akan disconnect setelah 5 menit jika tidak ada lagu yang diputar', inline: false }
            ],
            footer: { text: CONFIG.author }
          }]
        });
      }
    } catch (error) {
      console.error('Error join:', error);
      return message.reply({
        embeds: [{
          color: 0xFF0000,
          title: '❌ Error',
          description: `Terjadi kesalahan: ${error.message}`,
          footer: { text: CONFIG.author }
        }]
      });
    }
  }
};

// PLAY Command (Updated dengan Spotify & YouTube Music Support)
const playCommand = {
  name: 'play',
  description: 'Memutar lagu dari YouTube, Spotify, atau YouTube Music',
  aliases: ['p'],
  async execute(message, args, client) {
    if (!message.member.voice.channel) {
      return message.reply({
        embeds: [{
          color: 0xFF0000,
          title: '❌ Error',
          description: 'Anda harus berada dalam voice channel terlebih dahulu!',
          footer: { text: CONFIG.author }
        }]
      });
    }

    if (!args.length) {
      return message.reply({
        embeds: [{
          color: 0xFF0000,
          title: '❌ Error',
          description: `Penggunaan: \`${CONFIG.prefix}play <URL atau judul lagu>\``,
          footer: { text: CONFIG.author }
        }]
      });
    }

    const query = args.join(' ');
    const searchMessage = await message.reply({
      embeds: [{
        color: 0xFFFF00,
        title: '🔎 Mencari',
        description: `Mencari: ${query}`,
        footer: { text: CONFIG.author }
      }]
    });

    try {
      const player = client.player;
      const existingQueue = player.getQueue(message.guild);

      // Cek apakah bot sudah ada di voice channel lain
      if (existingQueue && existingQueue.connection) {
        const botVoiceChannel = existingQueue.connection.channel;
        
        if (botVoiceChannel.id !== message.member.voice.channel.id) {
          return searchMessage.edit({
            embeds: [{
              color: 0xFF0000,
              title: '❌ Bot Sedang Digunakan',
              description: `Bot sedang digunakan di voice channel lain`,
              fields: [
                { name: 'Voice Channel Saat Ini', value: `<#${botVoiceChannel.id}>`, inline: false },
                { name: 'Informasi', value: `Tunggu hingga bot selesai atau stop pemutaran terlebih dahulu`, inline: false }
              ],
              footer: { text: CONFIG.author }
            }]
          });
        }
      }

      const queue = player.createQueue(message.guild, {
        metadata: message.channel,
        leaveOnEmpty: true,
        leaveOnEmptyCooldown: 300000,
        leaveOnEnd: true,
        leaveOnEndCooldown: 300000
      });

      if (!queue.connection) {
        await queue.connect(message.member.voice.channel);
        // Clear idle timeout ketika bot mulai memutar
        clearIdleTimeout(message.guild);
      }

      // Tentukan search engine berdasarkan URL
      let searchEngine = 'youtube'; // Default
      
      if (query.includes('spotify.com')) {
        searchEngine = 'spotify';
      } else if (query.includes('music.youtube.com') || query.includes('youtu.be') || query.includes('youtube.com')) {
        searchEngine = 'youtube';
      }

      const result = await player.search(query, {
        requestedBy: message.author,
        searchEngine: searchEngine
      });

      if (!result || !result.tracks.length) {
        return searchMessage.edit({
          embeds: [{
            color: 0xFF0000,
            title: '❌ Tidak Ditemukan',
            description: `Lagu dengan judul/link "${query}" tidak ditemukan`,
            footer: { text: CONFIG.author }
          }]
        });
      }

      const track = result.tracks[0];
      queue.addTrack(track);

      if (!queue.playing) {
        await queue.play();
      }

      return searchMessage.edit({
        embeds: [{
          color: 0x00FF00,
          title: '✅ Lagu Ditambahkan',
          description: `${track.title}`,
          fields: [
            { name: 'Penyanyi', value: track.author, inline: true },
            { name: 'Durasi', value: formatDuration(track.durationMS), inline: true },
            { name: 'Posisi Antrian', value: `#${queue.tracks.length}`, inline: true },
            { name: 'Sumber', value: searchEngine.charAt(0).toUpperCase() + searchEngine.slice(1), inline: true }
          ],
          footer: { text: CONFIG.author }
        }]
      });

    } catch (error) {
      console.error('Error play:', error);
      return searchMessage.edit({
        embeds: [{
          color: 0xFF0000,
          title: '❌ Error',
          description: `Terjadi kesalahan saat memutar: ${error.message}`,
          footer: { text: CONFIG.author }
        }]
      });
    }
  }
};

// SKIP Command
const skipCommand = {
  name: 'skip',
  description: 'Skip lagu saat ini',
  aliases: ['s', 'next'],
  async execute(message, args, client) {
    const queue = client.player.getQueue(message.guild);

    if (!queue || !queue.playing) {
      return message.reply({
        embeds: [{
          color: 0xFF0000,
          title: '❌ Error',
          description: 'Tidak ada lagu yang sedang diputar',
          footer: { text: CONFIG.author }
        }]
      });
    }

    const currentTrack = queue.current;
    const skipped = queue.skip();

    if (skipped) {
      return message.reply({
        embeds: [{
          color: 0x00FF00,
          title: '⏭️ Lagu di-Skip',
          description: `${currentTrack.title}`,
          fields: [
            { name: 'Di-skip oleh', value: `<@${message.author.id}>`, inline: true },
            { name: 'Lagu Selanjutnya', value: queue.current ? queue.current.title : 'Tidak ada', inline: false }
          ],
          footer: { text: CONFIG.author }
        }]
      });
    }
  }
};

// SKIPTO Command
const skiptoCommand = {
  name: 'skipto',
  description: 'Skip ke lagu tertentu dalam antrian (nomor lagu)',
  aliases: ['st', 'jumpto'],
  async execute(message, args, client) {
    const queue = client.player.getQueue(message.guild);

    if (!queue || !queue.playing) {
      return message.reply({
        embeds: [{
          color: 0xFF0000,
          title: '❌ Error',
          description: 'Tidak ada lagu yang sedang diputar',
          footer: { text: CONFIG.author }
        }]
      });
    }

    if (!args.length) {
      return message.reply({
        embeds: [{
          color: 0xFF0000,
          title: '❌ Error',
          description: `Penggunaan: \`${CONFIG.prefix}skipto <nomor lagu>\` atau \`${CONFIG.prefix}st <nomor lagu>\`\nContoh: \`${CONFIG.prefix}skipto 3\``,
          footer: { text: CONFIG.author }
        }]
      });
    }

    const trackNumber = parseInt(args[0]) - 1;

    if (isNaN(trackNumber) || trackNumber < 0) {
      return message.reply({
        embeds: [{
          color: 0xFF0000,
          title: '❌ Error',
          description: 'Nomor lagu harus berupa angka positif',
          footer: { text: CONFIG.author }
        }]
      });
    }

    if (trackNumber >= queue.tracks.length) {
      return message.reply({
        embeds: [{
          color: 0xFF0000,
          title: '❌ Error',
          description: `Hanya ada ${queue.tracks.length} lagu dalam antrian`,
          footer: { text: CONFIG.author }
        }]
      });
    }

    try {
      const selectedTrack = queue.tracks[trackNumber];
      const currentTrack = queue.current;
      
      // Skip semua lagu sebelum lagu yang dipilih
      for (let i = 0; i <= trackNumber; i++) {
        queue.skip();
      }

      return message.reply({
        embeds: [{
          color: 0x00FF00,
          title: '⏩ Skip ke Lagu',
          description: `Skip ke lagu nomor ${args[0]}`,
          fields: [
            { name: 'Lagu yang Di-skip', value: `${currentTrack.title}`, inline: false },
            { name: 'Lagu yang Dimainkan', value: `${selectedTrack.title}`, inline: false },
            { name: 'Penyanyi', value: selectedTrack.author, inline: true },
            { name: 'Durasi', value: formatDuration(selectedTrack.durationMS), inline: true },
            { name: 'Di-skip oleh', value: `<@${message.author.id}>`, inline: true }
          ],
          footer: { text: CONFIG.author }
        }]
      });
    } catch (error) {
      console.error('Error skipto:', error);
      return message.reply({
        embeds: [{
          color: 0xFF0000,
          title: '❌ Error',
          description: `Terjadi kesalahan: ${error.message}`,
          footer: { text: CONFIG.author }
        }]
      });
    }
  }
};

// PAUSE Command
const pauseCommand = {
  name: 'pause',
  description: 'Pause lagu yang sedang diputar',
  async execute(message, args, client) {
    const queue = client.player.getQueue(message.guild);

    if (!queue || !queue.playing) {
      return message.reply({
        embeds: [{
          color: 0xFF0000,
          title: '❌ Error',
          description: 'Tidak ada lagu yang sedang diputar',
          footer: { text: CONFIG.author }
        }]
      });
    }

    const paused = queue.setPaused(true);

    if (paused) {
      // Set idle timeout ketika pause
      setIdleTimeout(message.guild, queue);
      
      return message.reply({
        embeds: [{
          color: 0xFFFF00,
          title: '⏸️ Pause',
          description: `${queue.current.title}`,
          fields: [
            { name: 'Di-pause oleh', value: `<@${message.author.id}>`, inline: false }
          ],
          footer: { text: CONFIG.author }
        }]
      });
    }
  }
};

// RESUME Command
const resumeCommand = {
  name: 'resume',
  description: 'Resume lagu yang di-pause',
  aliases: ['res'],
  async execute(message, args, client) {
    const queue = client.player.getQueue(message.guild);

    if (!queue || !queue.playing) {
      return message.reply({
        embeds: [{
          color: 0xFF0000,
          title: '❌ Error',
          description: 'Tidak ada lagu yang sedang diputar',
          footer: { text: CONFIG.author }
        }]
      });
    }

    const resumed = queue.setPaused(false);

    if (resumed) {
      // Clear idle timeout ketika resume
      clearIdleTimeout(message.guild);
      
      return message.reply({
        embeds: [{
          color: 0x00FF00,
          title: '▶️ Resume',
          description: `${queue.current.title}`,
          fields: [
            { name: 'Di-resume oleh', value: `<@${message.author.id}>`, inline: false }
          ],
          footer: { text: CONFIG.author }
        }]
      });
    }
  }
};

// STOP Command
const stopCommand = {
  name: 'stop',
  description: 'Stop dan hapus semua lagu dalam antrian',
  async execute(message, args, client) {
    const queue = client.player.getQueue(message.guild);

    if (!queue || !queue.playing) {
      return message.reply({
        embeds: [{
          color: 0xFF0000,
          title: '❌ Error',
          description: 'Tidak ada lagu yang sedang diputar',
          footer: { text: CONFIG.author }
        }]
      });
    }

    // Clear idle timeout
    clearIdleTimeout(message.guild);
    
    queue.destroy();

    return message.reply({
      embeds: [{
        color: 0xFF0000,
        title: '🛑 Stop',
        description: 'Pemutaran lagu dihentikan',
        fields: [
          { name: 'Di-stop oleh', value: `<@${message.author.id}>`, inline: false }
        ],
        footer: { text: CONFIG.author }
      }]
    });
  }
};

// CLEAR QUEUE Command
const clearCommand = {
  name: 'clear',
  description: 'Bersihkan semua lagu dalam antrian (lagu yang sedang diputar tetap)',
  aliases: ['clearqueue', 'cq'],
  async execute(message, args, client) {
    const queue = client.player.getQueue(message.guild);

    if (!queue || !queue.playing) {
      return message.reply({
        embeds: [{
          color: 0xFF0000,
          title: '❌ Error',
          description: 'Tidak ada lagu yang sedang diputar',
          footer: { text: CONFIG.author }
        }]
      });
    }

    if (queue.tracks.length === 0) {
      return message.reply({
        embeds: [{
          color: 0xFF0000,
          title: '❌ Error',
          description: 'Antrian sudah kosong',
          footer: { text: CONFIG.author }
        }]
      });
    }

    const clearedCount = queue.tracks.length;
    queue.clear();

    return message.reply({
      embeds: [{
        color: 0x00FF00,
        title: '🧹 Antrian Dibersihkan',
        description: `${clearedCount} lagu telah dihapus dari antrian`,
        fields: [
          { name: 'Dibersihkan oleh', value: `<@${message.author.id}>`, inline: true },
          { name: 'Lagu yang Masih Diputar', value: `${queue.current.title}`, inline: false }
        ],
        footer: { text: CONFIG.author }
      }]
    });
  }
};

// VOLUME Command
const volumeCommand = {
  name: 'volume',
  description: 'Atur volume pemutaran lagu',
  aliases: ['vol', 'v'],
  async execute(message, args, client) {
    const queue = client.player.getQueue(message.guild);

    if (!queue || !queue.playing) {
      return message.reply({
        embeds: [{
          color: 0xFF0000,
          title: '❌ Error',
          description: 'Tidak ada lagu yang sedang diputar',
          footer: { text: CONFIG.author }
        }]
      });
    }

    if (!args.length) {
      return message.reply({
        embeds: [{
          color: 0x00FFFF,
          title: '🔊 Volume Saat Ini',
          description: `Volume saat ini: ${queue.node.volume}%`,
          footer: { text: CONFIG.author }
        }]
      });
    }

    const volume = parseInt(args[0]);

    if (isNaN(volume)) {
      return message.reply({
        embeds: [{
          color: 0xFF0000,
          title: '❌ Error',
          description: 'Masukan harus berupa angka (0-200)',
          footer: { text: CONFIG.author }
        }]
      });
    }

    if (volume < 0 || volume > 200) {
      return message.reply({
        embeds: [{
          color: 0xFF0000,
          title: '❌ Error',
          description: 'Volume harus antara 0-200',
          footer: { text: CONFIG.author }
        }]
      });
    }

    queue.node.setVolume(volume);

    return message.reply({
      embeds: [{
        color: 0x00FF00,
        title: '🔊 Volume Diubah',
        description: `Volume diubah menjadi: ${volume}%`,
        fields: [
          { name: 'Volume Baru', value: `${volume}%`, inline: true },
          { name: 'Diubah oleh', value: `<@${message.author.id}>`, inline: true }
        ],
        footer: { text: CONFIG.author }
      }]
    });
  }
};

// NOW PLAYING Command (dengan rincian antrian)
const nowplayingCommand = {
  name: 'nowplaying',
  description: 'Tampilkan lagu yang sedang diputar dan antrian',
  aliases: ['np', 'queue'],
  async execute(message, args, client) {
    const queue = client.player.getQueue(message.guild);

    if (!queue || !queue.playing) {
      return message.reply({
        embeds: [{
          color: 0xFF0000,
          title: '❌ Error',
          description: 'Tidak ada lagu yang sedang diputar',
          footer: { text: CONFIG.author }
        }]
      });
    }

    const tracksPerPage = 10;
    const page = parseInt(args[0]) || 1;
    const pages = Math.ceil(queue.tracks.length / tracksPerPage);

    if (page > pages && pages > 0) {
      return message.reply({
        embeds: [{
          color: 0xFF0000,
          title: '❌ Error',
          description: `Halaman maksimal adalah ${pages}`,
          footer: { text: CONFIG.author }
        }]
      });
    }

    const start = (page - 1) * tracksPerPage;
    const end = start + tracksPerPage;
    const tracks = queue.tracks.slice(start, end);

    // Dapatkan info voice channel
    const voiceChannel = queue.connection.channel;
    const totalDuration = calculateTotalDuration(queue);

    let description = `**📍 Voice Channel:** <#${voiceChannel.id}>\n`;
    description += `**📊 Total Antrian:** ${queue.tracks.length} lagu\n`;
    description += `**⏰ Total Durasi:** ${totalDuration}\n\n`;
    description += `**🎵 Sekarang Diputar:**\n`;
    description += `1️⃣ ${queue.current.title}\n`;
    description += `**⏱️ Durasi:** ${formatDuration(queue.current.durationMS)}\n`;
    description += `**👤 Ditambahkan oleh:** <@${queue.current.requestedBy.id}>\n\n`;
    description += `**📋 Daftar Antrian:**\n`;

    if (queue.tracks.length === 0) {
      description += `*(Antrian Kosong)*`;
    } else {
      tracks.forEach((track, i) => {
        description += `${i + start + 2}. ${track.title} - ${formatDuration(track.durationMS)}\n`;
      });
    }

    const embed = new EmbedBuilder()
      .setColor(0x00FF00)
      .setTitle('🎵 Sedang Memutar')
      .setDescription(description)
      .setFooter({ text: `Halaman ${page} dari ${pages || 1} | ${CONFIG.author}` });

    return message.reply({ embeds: [embed] });
  }
};

// SHUFFLE Command
const shuffleCommand = {
  name: 'shuffle',
  description: 'Shuffle/acak antrian lagu',
  async execute(message, args, client) {
    const queue = client.player.getQueue(message.guild);

    if (!queue || !queue.playing) {
      return message.reply({
        embeds: [{
          color: 0xFF0000,
          title: '❌ Error',
          description: 'Tidak ada lagu yang sedang diputar',
          footer: { text: CONFIG.author }
        }]
      });
    }

    if (queue.tracks.length === 0) {
      return message.reply({
        embeds: [{
          color: 0xFF0000,
          title: '❌ Error',
          description: 'Tidak ada lagu dalam antrian untuk di-shuffle',
          footer: { text: CONFIG.author }
        }]
      });
    }

    queue.tracks.sort(() => Math.random() - 0.5);

    return message.reply({
      embeds: [{
        color: 0x00FF00,
        title: '🔀 Shuffle',
        description: `${queue.tracks.length} lagu dalam antrian telah di-shuffle`,
        fields: [
          { name: 'Di-shuffle oleh', value: `<@${message.author.id}>`, inline: false }
        ],
        footer: { text: CONFIG.author }
      }]
    });
  }
};

// HELP Command
const helpCommand = {
  name: 'help',
  description: 'Tampilkan bantuan',
  aliases: ['h', 'bantuan'],
  async execute(message, args, client) {
    const commands = [
      { name: `${CONFIG.prefix}join (${CONFIG.prefix}j)`, desc: 'Join ke voice channel Anda' },
      { name: `${CONFIG.prefix}play <URL/judul>`, desc: 'Putar lagu dari YouTube, Spotify, atau YouTube Music' },
      { name: `${CONFIG.prefix}skip (${CONFIG.prefix}s)`, desc: 'Skip lagu saat ini' },
      { name: `${CONFIG.prefix}skipto <nomor> (${CONFIG.prefix}st)`, desc: 'Skip ke lagu nomor tertentu dalam antrian' },
      { name: `${CONFIG.prefix}pause`, desc: 'Pause lagu yang sedang diputar' },
      { name: `${CONFIG.prefix}resume (${CONFIG.prefix}res)`, desc: 'Resume lagu yang di-pause' },
      { name: `${CONFIG.prefix}stop`, desc: 'Stop pemutaran dan disconnect' },
      { name: `${CONFIG.prefix}clear (${CONFIG.prefix}cq)`, desc: 'Bersihkan semua lagu dalam antrian' },
      { name: `${CONFIG.prefix}volume <angka> (${CONFIG.prefix}vol)`, desc: 'Atur volume (0-200)' },
      { name: `${CONFIG.prefix}nowplaying (${CONFIG.prefix}np)`, desc: 'Tampilkan lagu yang sedang diputar dan antrian' },
      { name: `${CONFIG.prefix}shuffle`, desc: 'Shuffle/acak antrian lagu' },
      { name: `${CONFIG.prefix}help (${CONFIG.prefix}h)`, desc: 'Tampilkan bantuan' },
      { name: `d0pper.changeprefix <prefix>`, desc: 'Ubah prefix (Admin only)' }
    ];

    let description = '';
    commands.forEach(cmd => {
      description += `**${cmd.name}** - ${cmd.desc}\n`;
    });

    const embed = new EmbedBuilder()
      .setColor(0x00FFFF)
      .setTitle('📚 Daftar Perintah Bot Musik')
      .setDescription(description)
      .setFooter({ text: `Prefix Saat Ini: ${CONFIG.prefix} | ${CONFIG.author}` });

    return message.reply({ embeds: [embed] });
  }
};

// Register all commands
const commands = [
  changePrefixCommand,
  joinCommand,
  playCommand,
  skipCommand,
  skiptoCommand,
  pauseCommand,
  resumeCommand,
  stopCommand,
  clearCommand,
  volumeCommand,
  nowplayingCommand,
  shuffleCommand,
  helpCommand
];

commands.forEach(cmd => {
  client.commands.set(cmd.name, cmd);
});

// ============ PLAYER EVENTS ============

player.on('trackStart', (queue, track) => {
  // Clear idle timeout ketika lagu mulai diputar
  clearIdleTimeout(queue.guild);
  
  const channel = queue.metadata;
  if (channel) {
    channel.send({
      embeds: [{
        color: 0x00FF00,
        title: '🎵 Sedang Memutar',
        description: `${track.title}`,
        fields: [
          { name: 'Penyanyi', value: track.author, inline: true },
          { name: 'Durasi', value: formatDuration(track.durationMS), inline: true },
          { name: 'Ditambahkan oleh', value: `<@${track.requestedBy.id}>`, inline: true }
        ],
        footer: { text: CONFIG.author }
      }]
    });
  }
});

player.on('trackEnd', (queue) => {
  const channel = queue.metadata;
  
  // Jika tidak ada lagu selanjutnya, set idle timeout
  if (queue.tracks.length === 0) {
    setIdleTimeout(queue.guild, queue);
  }
  
  if (channel && queue.tracks.length === 0) {
    channel.send({
      embeds: [{
        color: 0xFF0000,
        title: '🛑 Antrian Kosong',
        description: 'Tidak ada lagu lagi dalam antrian. Bot akan disconnect setelah 5 menit jika tidak ada lagu yang diputar',
        footer: { text: CONFIG.author }
      }]
    });
  }
});

player.on('error', (queue, error) => {
  console.error('Error pemain musik:', error);
  const channel = queue.metadata;
  if (channel) {
    channel.send({
      embeds: [{
        color: 0xFF0000,
        title: '❌ Error',
        description: `Terjadi kesalahan: ${error.message}`,
        footer: { text: CONFIG.author }
      }]
    });
  }
});

// ============ CLIENT EVENTS ============

// Ready Event
client.on('ready', async () => {
    console.log(`✅ Bot siap! Login sebagai ${client.user.tag}`);
    console.log(`📝 Made by - d0pper16`);
    console.log(`🔧 Prefix saat ini: ${CONFIG.prefix}`);
    console.log(`🎵 Spotify Support: ${CONFIG.spotifyClientId ? '✅ Aktif' : '❌ Tidak aktif'}`);
    
    // Start Keep Alive
    try {
        await startKeepAlive();
        console.log('✅ Keep-Alive system initialized\n');
    } catch (error) {
        console.error('❌ Failed to start Keep-Alive:', error.message);
    }
    
    client.user.setActivity(`${CONFIG.prefix}help untuk bantuan`, { type: 'LISTENING' });
});

// ============ UPDATE GRACEFUL SHUTDOWN ============
async function gracefulShutdown(signal) {
    console.log(`\n📥 Received ${signal}, shutting down gracefully...`);
    
    try {
        console.log('🛑 Stopping keep-alive server...');
        await stopKeepAlive();
        
        console.log('💥 Destroying Discord client...');
        client.destroy();
        
        console.log('⏻ Shutdown complete');
        process.exit(0);
    } catch (error) {
        console.error('⛔ Error during shutdown:', error);
        process.exit(1);
    }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Message Create Event
client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;

  // Cek untuk command khusus d0pper.changeprefix
  if (message.content.startsWith('d0pper.changeprefix')) {
    const args = message.content.slice('d0pper.changeprefix'.length).trim().split(/ +/);
    const command = client.commands.get('d0pper.changeprefix');
    if (command) {
      try {
        await command.execute(message, args, client);
      } catch (error) {
        console.error('Error executing changeprefix command:', error);
        message.reply({
          embeds: [{
            color: 0xFF0000,
            title: '❌ Error',
            description: `Terjadi kesalahan: ${error.message}`,
            footer: { text: CONFIG.author }
          }]
        });
      }
    }
    return;
  }

  if (!message.content.startsWith(CONFIG.prefix)) return;

  const args = message.content.slice(CONFIG.prefix.length).trim().split(/ +/);
  const commandName = args.shift().toLowerCase();

  const command = client.commands.get(commandName) ||
    client.commands.find(cmd => cmd.aliases && cmd.aliases.includes(commandName));

  if (!command) return;

  try {
    await command.execute(message, args, client);
  } catch (error) {
    console.error('Error executing command:', error);
    message.reply({
      embeds: [{
        color: 0xFF0000,
        title: '❌ Error',
        description: `Terjadi kesalahan saat menjalankan perintah: ${error.message}`,
        footer: { text: CONFIG.author }
      }]
    });
  }
});

// ==========================================
// BOT STATS SENDER (Untuk Multi-Bot Manager)
// ==========================================
if (process.send) {
  setInterval(() => {
    try {
      const memUsage = process.memoryUsage();
      const ramMB = memUsage.heapUsed / 1024 / 1024;
      
      process.send({
        type: 'stats',
        memory: parseFloat(ramMB.toFixed(2)),
        cpu: Math.random() * 30 // Placeholder - ganti dengan actual CPU jika perlu
      });
    } catch (e) {
      console.error('Error sending stats:', e.message);
    }
  }, 5000); // Update setiap 5 detik
}

// ============ LOGIN ============
client.login(CONFIG.token);
