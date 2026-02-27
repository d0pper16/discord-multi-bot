// ==========================================
// DISCORD AUTO VOICE CHANNEL BOT - by D0PPER.
// ==========================================

// ==========================================
// AUTO HEAP SIZE DETECTION & RESTART
// ==========================================

const { spawn } = require('child_process');
const v8 = require('v8');

// Cek apakah heap size sudah cukup
const heapStats = v8.getHeapStatistics();
const currentHeapLimit = Math.round(heapStats.heap_size_limit / 1024 / 1024);
const desiredHeapSize = 1792; // sesuaikan dengan spesifikasi server

console.log(`📊 Current heap limit: ${currentHeapLimit}MB`);
console.log(`🎯 Desired heap size: ${desiredHeapSize}MB`);

if (currentHeapLimit !== desiredHeapSize && !process.env.RESTARTED) {
    console.log(`⚠️  Heap size mismatch (${currentHeapLimit}MB ≠ ${desiredHeapSize}MB)`);
    console.log(`🔄 Restarting with exactly ${desiredHeapSize}MB heap...`);

    const child = spawn('node', [
        `--max-old-space-size=${desiredHeapSize}`,
        '--expose-gc',
        __filename,
        ...process.argv.slice(2)
    ], {
        stdio: 'inherit',
        env: { ...process.env, RESTARTED: '1' }
    });
    
    child.on('exit', (code) => {
        console.log(`🔚 Child process exited with code ${code}`);
        process.exit(code);
    });
    
    child.on('error', (error) => {
        console.error('❌ Failed to restart:', error);
        process.exit(1);
    });
    
    return;
}

console.log(`✅ Running with ${currentHeapLimit}MB heap limit`);

// Validasi bahwa heap size sudah sesuai
if (currentHeapLimit < 700) {
    console.warn('⚠️  WARNING: Heap size masih terlalu kecil!');
    console.warn('💡 Pastikan restart berhasil atau jalankan manual dengan:');
    console.warn(`   node --max-old-space-size=${desiredHeapSize} index.js`);
}

const { 
    Client, 
    GatewayIntentBits, 
    EmbedBuilder, 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle, 
    StringSelectMenuBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    PermissionFlagsBits,
    ChannelType
} = require('discord.js');

const fs = require('fs');
require('dotenv').config();
const { startKeepAlive, stopKeepAlive } = require('./keepalive');

// ==========================================
// PERFORMANCE OPTIMIZATION UTILITIES
// ==========================================
const EventEmitter = require('events');
EventEmitter.defaultMaxListeners = 15; // Prevent memory leak warnings

// Debounce function untuk mencegah spam
function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

// Throttle function untuk rate limiting
function throttle(func, limit) {
    let inThrottle;
    return function(...args) {
        if (!inThrottle) {
            func.apply(this, args);
            inThrottle = true;
            setTimeout(() => inThrottle = false, limit);
        }
    };
}

// Cache dengan TTL dan MAX SIZE untuk mencegah memory leak
class TTLCache {
    constructor(ttl = 60000, maxSize = 1000) { // Default 1 menit, max 1000 items
        this.cache = new Map();
        this.ttl = ttl;
        this.maxSize = maxSize;
    }

    set(key, value) {
        // Hapus item tertua jika cache penuh
        if (this.cache.size >= this.maxSize) {
            const firstKey = this.cache.keys().next().value;
            this.cache.delete(firstKey);
            console.log(`🗑️  Cache full, removed oldest item: ${firstKey}`);
        }
        
        this.cache.set(key, {
            value,
            timestamp: Date.now()
        });
    }

    get(key) {
        const item = this.cache.get(key);
        if (!item) return null;
        
        // Check TTL expiry
        if (Date.now() - item.timestamp > this.ttl) {
            this.cache.delete(key);
            return null;
        }
        
        return item.value;
    }
    
    clear() {
        const size = this.cache.size;
        this.cache.clear();
        console.log(`🧹 Cleared ${size} items from cache`);
    }
    
    size() {
        return this.cache.size;
    }
    
    // Method untuk cleanup expired items
    cleanExpired() {
        const now = Date.now();
        let cleaned = 0;
        
        for (const [key, item] of this.cache.entries()) {
            if (now - item.timestamp > this.ttl) {
                this.cache.delete(key);
                cleaned++;
            }
        }
        
        if (cleaned > 0) {
            console.log(`🧹 Cleaned ${cleaned} expired cache items`);
        }
        
        return cleaned;
    }
}

// Global caches dengan max size
const memberCache = new TTLCache(120000, 500);  // 2 menit, max 500 members
const channelCache = new TTLCache(300000, 100); // 5 menit, max 100 channels

// CACHE INVALIDATION FUNCTIONS
function invalidateMemberCache(userId) {
    if (memberCache.cache.has(userId)) {
        memberCache.cache.delete(userId);
        console.log(`🧹 Invalidated member cache for ${userId}`);
    }
}

function invalidateChannelCache(channelId) {
    if (channelCache.cache.has(channelId)) {
        channelCache.cache.delete(channelId);
        console.log(`🧹 Invalidated channel cache for ${channelId}`);
    }
}

// Operation queue untuk mencegah race condition
class OperationQueue {
    constructor() {
        this.queues = new Map();
        this.processing = new Set();
    }
    
    async add(key, operation) {
        if (!this.queues.has(key)) {
            this.queues.set(key, []);
        }
        
        return new Promise((resolve, reject) => {
            this.queues.get(key).push({ operation, resolve, reject });
            this.process(key);
        });
    }
    
    async process(key) {
        if (this.processing.has(key)) return;
        
        const queue = this.queues.get(key);
        if (!queue || queue.length === 0) {
            this.queues.delete(key);
            return;
        }
        
        this.processing.add(key);
        const { operation, resolve, reject } = queue.shift();
        
        try {
            const result = await operation();
            resolve(result);
        } catch (error) {
            reject(error);
        } finally {
            this.processing.delete(key);
            this.process(key);
        }
    }
}

const operationQueue = new OperationQueue();

// ==========================================
// CONCURRENT VOICE JOIN HANDLER
// ==========================================
class VoiceJoinQueue extends require('events').EventEmitter {
    constructor(options = {}) {
        super();
        
        this.maxConcurrent = options.maxConcurrent || 3;
        this.processingDelay = options.processingDelay || 500;
        this.maxQueueSize = options.maxQueueSize || 50;
        this.batchSize = options.batchSize || 5;
        
        this.queue = [];
        this.processing = new Set();
        this.locks = new Map();
        this.userLastJoin = new Map();
        this.stats = {
            totalProcessed: 0,
            totalRejected: 0,
            totalQueued: 0,
            concurrentPeak: 0,
            avgProcessingTime: 0
        };
        
        this.userRateLimit = 2000; // 2 seconds
        this.isProcessing = false;
    }
    
async enqueue(data) {
        const { userId, username, timestamp = Date.now() } = data;
        
        // Check queue size limit
        if (this.queue.length >= this.maxQueueSize) {
            console.error(`🚫 [QUEUE-FULL] Queue penuh (${this.queue.length}/${this.maxQueueSize})`);
            this.stats.totalRejected++;
            throw new Error('QUEUE_FULL: Antrian penuh, coba lagi nanti');
        }
        
        // Check if already in queue
        const alreadyQueued = this.queue.find(item => item.userId === userId);
        if (alreadyQueued) {
            console.log(`⚠️  [DUPLICATE] User ${username} sudah dalam queue`);
            return alreadyQueued.promise;
        }
        
        // Check if already processing
        if (this.processing.has(userId)) {
            console.log(`⚙️  [PROCESSING] User ${username} sedang diproses`);
            throw new Error('ALREADY_PROCESSING: Voice channel sedang dibuat');
        }
        
        // Add to queue
        const queueItem = {
            userId,
            username,
            channelId: data.channelId,
            guildId: data.guildId,
            member: data.member,
            timestamp,
            startTime: Date.now(),
            promise: null,
            resolve: null,
            reject: null
        };
        
        queueItem.promise = new Promise((resolve, reject) => {
            queueItem.resolve = resolve;
            queueItem.reject = reject;
        });
        
        this.queue.push(queueItem);
        this.stats.totalQueued++;
        
        console.log(`➕ [QUEUE] ${username} ditambahkan (Posisi: ${this.queue.length}, Processing: ${this.processing.size})`);
        
        this.emit('queued', queueItem);
        
        if (!this.isProcessing) {
            this.startProcessing();
        }
        
        return queueItem.promise;
    }
    
    async startProcessing() {
        if (this.isProcessing) return;
        this.isProcessing = true;
        
        console.log(`🎬 [QUEUE] Queue processor dimulai...`);
        
        while (this.queue.length > 0 || this.processing.size > 0) {
            if (this.processing.size >= this.maxConcurrent) {
                await this.sleep(100);
                continue;
            }
            
            const batch = this.queue.splice(0, this.batchSize);
            
            if (batch.length === 0) {
                await this.sleep(100);
                continue;
            }
            
            const currentConcurrent = this.processing.size + batch.length;
            if (currentConcurrent > this.stats.concurrentPeak) {
                this.stats.concurrentPeak = currentConcurrent;
            }
            
            console.log(`📦 [BATCH] Processing ${batch.length} users (Queue: ${this.queue.length}, Processing: ${this.processing.size})`);
            
            for (const item of batch) {
                this.processSingleItem(item);
            }
            
            if (this.queue.length > 0) {
                await this.sleep(this.processingDelay);
            }
        }
        
        this.isProcessing = false;
        console.log(`✅ [QUEUE] Queue processor selesai`);
        this.emit('idle');
    }
    
    async processSingleItem(item) {
        const { userId, username, resolve, reject, startTime } = item;
        
        this.processing.add(userId);
        
        console.log(`⚙️  [PROCESS] Processing ${username}... (Concurrent: ${this.processing.size})`);
        
        try {
            this.userLastJoin.set(userId, Date.now());
            
            const result = await new Promise((res, rej) => {
                const timeout = setTimeout(() => {
                    rej(new Error('TIMEOUT: Voice channel creation timeout'));
                }, 30000);
                
                this.emit('process', {
                    ...item,
                    resolve: (data) => {
                        clearTimeout(timeout);
                        res(data);
                    },
                    reject: (error) => {
                        clearTimeout(timeout);
                        rej(error);
                    }
                });
            });
            
            const processingTime = Date.now() - startTime;
            
            const totalProcessed = this.stats.totalProcessed;
            this.stats.avgProcessingTime = 
                (this.stats.avgProcessingTime * totalProcessed + processingTime) / (totalProcessed + 1);
            
            this.stats.totalProcessed++;
            
            console.log(`✅ [SUCCESS] ${username} processed dalam ${processingTime}ms`);
            
            resolve(result);
            
        } catch (error) {
            console.error(`❌ [ERROR] Gagal process ${username}:`, error.message);
            this.stats.totalRejected++;
            reject(error);
            
        } finally {
            this.processing.delete(userId);
            
            const oneHourAgo = Date.now() - 3600000;
            for (const [uid, timestamp] of this.userLastJoin.entries()) {
                if (timestamp < oneHourAgo) {
                    this.userLastJoin.delete(uid);
                }
            }
        }
    }
    
    async acquireLock(channelId, timeout = 5000) {
        const startTime = Date.now();
        
        while (this.locks.has(channelId)) {
            if (Date.now() - startTime > timeout) {
                // Auto-release jika timeout
                console.warn(`⚠️ [LOCK] Force releasing lock for ${channelId} (timeout)`);
                this.locks.delete(channelId);
                break;
            }
            await this.sleep(50);
        }
        
        // Set lock dengan auto-release timer
        const lockTimer = setTimeout(() => {
            if (this.locks.has(channelId)) {
                console.warn(`⚠️ [LOCK] Auto-releasing expired lock for ${channelId}`);
                this.locks.delete(channelId);
            }
        }, 30000); // 30 second auto-release
        
        this.locks.set(channelId, {
            timestamp: Date.now(),
            timer: lockTimer
        });
        
        console.log(`🔒 [LOCK] Lock acquired untuk channel ${channelId}`);
    }
    
    releaseLock(channelId) {
        const lock = this.locks.get(channelId);
        if (lock && lock.timer) {
            clearTimeout(lock.timer);
        }
        this.locks.delete(channelId);
        console.log(`🔓 [UNLOCK] Lock released untuk channel ${channelId}`);
    }
    
    getStats() {
        return {
            ...this.stats,
            queueLength: this.queue.length,
            processingCount: this.processing.size,
            lockedChannels: this.locks.size,
            cachedUsers: this.userLastJoin.size
        };
    }
    
    clear() {
        this.queue.forEach(item => {
            item.reject(new Error('QUEUE_CLEARED: Queue dibersihkan'));
        });
        
        this.queue = [];
        this.processing.clear();
        this.locks.clear();
        
        console.log(`🧹 [CLEAR] Queue dibersihkan`);
    }
    
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// Global concurrent voice manager
let concurrentVoiceManager = null;

// Initialize function
async function initializeConcurrentVoiceManager() {
    const voiceQueue = new VoiceJoinQueue({
        maxConcurrent: 3,
        processingDelay: 500,
        maxQueueSize: 50,
        batchSize: 5
    });
    
    // Handle process event
    voiceQueue.on('process', async (data) => {
        try {
            const result = await processVoiceChannelCreation(data);
            data.resolve(result);
        } catch (error) {
            data.reject(error);
        }
    });
    
    concurrentVoiceManager = {
        queue: voiceQueue,
        stats: {
            totalJoins: 0,
            simultaneousJoins: 0,
            maxSimultaneous: 0,
            errors: 0
        }
    };
    
    // Log stats setiap 1 jam
    setInterval(() => {
        const queueStats = voiceQueue.getStats();
        
        if (queueStats.queueLength > 0 || queueStats.processingCount > 0) {
            console.log('\n📊 [STATS] Concurrent Voice Manager:');
            console.log(`   Queue: ${queueStats.queueLength} | Processing: ${queueStats.processingCount}`);
            console.log(`   Total Processed: ${queueStats.totalProcessed} | Rejected: ${queueStats.totalRejected}`);
            console.log(`   Peak Concurrent: ${queueStats.concurrentPeak} | Avg Time: ${Math.round(queueStats.avgProcessingTime)}ms`);
        }
    }, 3600000);
    
    // Reset daily stats
    setInterval(() => {
        console.log('\n📊 Resetting daily voice statistics...');
        concurrentVoiceManager.stats = {
            totalJoins: 0,
            simultaneousJoins: 0,
            maxSimultaneous: 0,
            errors: 0
        };
        console.log('✅ Daily stats reset complete\n');
    }, 86400000); // 24 hours
    
    console.log('✅ Concurrent Voice Manager initialized');
}

// Process voice channel creation (akan dipanggil dari queue)
async function processVoiceChannelCreation(data) {
    const { userId, username, channelId, guildId, member } = data;
    const guild = client.guilds.cache.get(guildId);
    
    if (!guild) {
        throw new Error('Guild not found');
    }
    
    // Acquire lock
    await concurrentVoiceManager.queue.acquireLock(`user_${userId}`);
    
    try {
        const generatorChannel = guild.channels.cache.get(channelId);
        if (!generatorChannel) {
            throw new Error('Generator channel not found');
        }
        
        const generatorConfig = CONFIG.categories.find(c => c.generator === channelId);
        if (!generatorConfig) {
            throw new Error('Generator config not found');
        }
        
        const category = guild.channels.cache.get(generatorConfig.id);
        if (!category) {
            throw new Error('Category not found');
        }
        
        // === GUNAKAN createVoiceChannelDirect (bypass operationQueue dan cooldown) ===
        const voiceChannel = await createVoiceChannelDirect(member, category, generatorChannel);
        
        if (!voiceChannel) {
            throw new Error('Failed to create voice channel');
        }
        
        console.log(`🎉 [CREATED] Channel "${voiceChannel.name}" untuk ${username}`);
        
        return {
            success: true,
            channelId: voiceChannel.id,
            channelName: voiceChannel.name
        };
        
    } finally {
        concurrentVoiceManager.queue.releaseLock(`user_${userId}`);
    }
}

// Direct voice channel creation (bypass operationQueue untuk concurrent manager)
async function createVoiceChannelDirect(member, category, generatorChannel) {
    console.log(`\n🎤 [DIRECT] Membuat voice channel untuk: ${member.user.tag}`);
    const userId = member.id;
    const now = Date.now();
    
    // Check if user can access this category
    const categoryConfig = CONFIG.categories.find(c => c.id === category.id);
    if (categoryConfig && !canAccessCategory(member, categoryConfig)) {
        console.log(`❌ ${member.user.tag} tidak punya akses ke ${categoryConfig.name}`);
        throw new Error('No access to this category');
    }
    
    // Check if user already has a channel
    const existingChannel = Object.keys(voiceData.owners).find(channelId => voiceData.owners[channelId] === userId);
    if (existingChannel) {
        const channel = member.guild.channels.cache.get(existingChannel);
        if (channel) {
            console.log(`⚠️ ${member.user.tag} sudah punya channel: ${channel.name}`);
            throw new Error('User already has a voice channel');
        }
    }
    
    try {
        console.log('📋 Menyalin permissions dari category...');
        const categoryPermissions = category.permissionOverwrites.cache.map(overwrite => ({
            id: overwrite.id,
            allow: overwrite.allow.bitfield,
            deny: overwrite.deny.bitfield,
            type: overwrite.type
        }));
        
        console.log('🔄 Membuat voice channel...');
        const voiceChannel = await category.children.create({
            name: `${member.displayName} Voice`,
            type: ChannelType.GuildVoice,
            permissionOverwrites: [
                ...categoryPermissions,
                {
                    id: member.id,
                    allow: [
                        PermissionFlagsBits.Connect,
                        PermissionFlagsBits.Speak,
                        PermissionFlagsBits.Stream,
                    ]
                }
            ]
        });
        console.log(`✅ Voice channel dibuat: ${voiceChannel.name}`);
        
        // Update data
        voiceData.owners[voiceChannel.id] = userId;
        voiceData.cooldowns[userId] = now;
        voiceData.hiddenUsers[voiceChannel.id] = [];
        voiceData.joinOrder[voiceChannel.id] = [{ userId: userId, timestamp: now }];
        delete voiceData.ownerLeftTime[voiceChannel.id];
        saveData();
        
        console.log('🚶 Memindahkan user ke voice channel...');
        await member.voice.setChannel(voiceChannel);
        
        // Set permission untuk open chat
        try {
            console.log('🔒 Setting up open chat permissions...');
    
            await voiceChannel.permissionOverwrites.edit(voiceChannel.guild.roles.everyone, {
                ViewChannel: true,
                SendMessages: false,
                ReadMessageHistory: true
            });
    
            await voiceChannel.permissionOverwrites.edit(member.id, {
                ViewChannel: true,
                SendMessages: true,
                ReadMessageHistory: true,
                Connect: true,
                Speak: true,
                Stream: true,
            });
    
            console.log('✅ Open chat permissions set');
        } catch (e) {
            console.error('❌ Error setting open chat permissions:', e.message);
        }

        try {
            await voiceChannel.send(`👋 Selamat datang ${member}! Gunakan panel kontrol di text channel untuk mengatur voice ini.`);
        } catch (e) {
            console.log('⚠️ Voice channel tidak support text chat atau bot tidak punya permission');
        }
        
        await sendLog(category.guild, 'Voice Created', {
            'User': member.toString(),
            'Channel': voiceChannel.name,
            'Category': category.name
        });
        
        console.log('✅ Voice channel berhasil dibuat!\n');
        return voiceChannel;
        
    } catch (e) {
        console.error('❌ Error membuat voice channel:', e.message);
        console.error('Stack:', e.stack);
        throw e; // Rethrow untuk ditangani oleh concurrent manager
    }
}

// Handle concurrent voice join
async function handleConcurrentVoiceJoin(oldState, newState) {
    const member = newState.member;
    const userId = member.id;
    const username = member.user.username;
    
    console.log(`\n🎤 [VOICE-JOIN] ${username} joined trigger channel`);
    
    // Track statistics
    concurrentVoiceManager.stats.totalJoins++;
    concurrentVoiceManager.stats.simultaneousJoins++;
    
    if (concurrentVoiceManager.stats.simultaneousJoins > concurrentVoiceManager.stats.maxSimultaneous) {
        concurrentVoiceManager.stats.maxSimultaneous = concurrentVoiceManager.stats.simultaneousJoins;
    }
    
    // Decrement after 2 seconds
    setTimeout(() => {
        concurrentVoiceManager.stats.simultaneousJoins = Math.max(0, concurrentVoiceManager.stats.simultaneousJoins - 1);
    }, 2000);
    
    try {
        // Enqueue the join request
        const result = await concurrentVoiceManager.queue.enqueue({
            userId,
            username,
            channelId: newState.channelId,
            guildId: newState.guild.id,
            member,
            timestamp: Date.now()
        });
        
        console.log(`✅ [COMPLETE] Voice channel created untuk ${username}: ${result.channelName}`);
        
    } catch (error) {
        console.error(`❌ [ERROR] Gagal handle voice join untuk ${username}:`, error.message);
        concurrentVoiceManager.stats.errors++;
        
        // Kirim pesan error ke user (optional)
        if (error.message.includes('RATE_LIMIT')) {
            try {
                await member.send('⏱️ Kamu terlalu cepat join voice! Tunggu 2 detik ya.').catch(() => {});
            } catch (e) {
                // Ignore DM errors
            }
        }
    }
}

// Cleanup expired data periodically
setInterval(() => {
    const now = Date.now();
    
    // Clean expired cooldowns
    Object.keys(voiceData.buttonCooldowns).forEach(userId => {
        if (now - voiceData.buttonCooldowns[userId] > 300000) { // 5 menit
            delete voiceData.buttonCooldowns[userId];
        }
    });
    
    // Clean expired hide/unhide cooldowns
    Object.keys(voiceData.hideUnhideCooldowns).forEach(userId => {
        if (now - voiceData.hideUnhideCooldowns[userId] > 60000) { // 1 menit
            delete voiceData.hideUnhideCooldowns[userId];
        }
    });
    
    // Clean expired creation cooldowns
    Object.keys(voiceData.cooldowns).forEach(userId => {
        if (now - voiceData.cooldowns[userId] > 120000) { // 2 menit
            delete voiceData.cooldowns[userId];
        }
    });
    
    // ← TAMBAHKAN BLOK INI (ownerLeftTime cleanup)
    // Clean expired ownerLeftTime (lebih dari 30 menit)
    Object.keys(voiceData.ownerLeftTime).forEach(channelId => {
        if (now - voiceData.ownerLeftTime[channelId] > CONFIG.ownerLeaveDelay) {
            delete voiceData.ownerLeftTime[channelId];
            console.log(`🗑️ Cleaned expired ownerLeftTime for channel ${channelId}`);
        }
    });
    
    console.log('♻️ Cleaned expired cooldown data');
}, 3600000); // Setiap 1 JAM


// ==========================================
// VALIDASI ENVIRONMENT VARIABLES
// ==========================================
console.log('='.repeat(50));
console.log('🔍 MEMULAI VALIDASI KONFIGURASI...');
console.log('='.repeat(50));

if (!process.env.DISCORD_TOKEN) {
    console.error('❌ ERROR: DISCORD_TOKEN tidak ditemukan di file .env!');
    console.error('📝 Pastikan file .env ada dan berisi token yang valid');
    process.exit(1);
}

const maskedToken = process.env.DISCORD_TOKEN.substring(0, 20) + '...' + process.env.DISCORD_TOKEN.substring(process.env.DISCORD_TOKEN.length - 5);
console.log('✅ Token terdeteksi:', maskedToken);

const requiredEnvVars = [
    'ADMIN_ROLE_ID', 'PREMIUM1_ROLE_ID', 'PREMIUM2_ROLE_ID', 'VIP_ROLE_ID',
    'CATEGORY1_ID', 'CATEGORY2_ID', 'CATEGORY3_ID',
    'VOICE_GEN1_ID', 'VOICE_GEN2_ID', 'VOICE_GEN3_ID',
    'PANEL_CHANNEL1_ID', 'PANEL_CHANNEL2_ID', 'PANEL_CHANNEL3_ID',
    'LOG_CHANNEL_ID'
];

let hasError = false;
requiredEnvVars.forEach(varName => {
    if (!process.env[varName] || process.env[varName].trim() === '') {
        console.error(`❌ ERROR: ${varName} kosong atau tidak ada!`);
        hasError = true;
    } else {
        console.log(`✅ ${varName}:`, process.env[varName]);
    }
});

if (hasError) {
    console.error('\n❌ KONFIGURASI TIDAK LENGKAP!');
    console.error('📝 Pastikan semua ID sudah diisi di file .env');
    process.exit(1);
}

console.log('\n✅ Semua konfigurasi valid!\n');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ]
});

// ==========================================
// CONFIGURATION
// ==========================================
const CONFIG = {
    adminRole: process.env.ADMIN_ROLE_ID,
    premium1Role: process.env.PREMIUM1_ROLE_ID,
    premium2Role: process.env.PREMIUM2_ROLE_ID,
    vipRole: process.env.VIP_ROLE_ID,
    categories: [
        { id: process.env.CATEGORY1_ID, generator: process.env.VOICE_GEN1_ID, panel: process.env.PANEL_CHANNEL1_ID, name: 'Chill Lounge 1', requireVip: false },
        { id: process.env.CATEGORY2_ID, generator: process.env.VOICE_GEN2_ID, panel: process.env.PANEL_CHANNEL2_ID, name: 'Chill Lounge 2', requireVip: false },
        { id: process.env.CATEGORY3_ID, generator: process.env.VOICE_GEN3_ID, panel: process.env.PANEL_CHANNEL3_ID, name: 'VIP Lounge', requireVip: true }
    ],
    logChannel: process.env.LOG_CHANNEL_ID,
    logEnabled: true,
    maxHiddenUsers: 3,
    ownerLeaveDelay: 30 * 60 * 1000, // 30 menit
    hideUnhideCooldown: 10 * 1000, // 10 detik
    buttonCooldownMin: 1000, // 1 detik
    buttonCooldownMax: 5000  // 5 detik
};

// ==========================================
// DATA STORAGE
// ==========================================
const DATA_FILE = './voice_data.json';
let voiceData = {
    owners: {},
    panelMessages: {},
    cooldowns: {},
    hiddenUsers: {},
    joinOrder: {},
    ownerLeftTime: {},
    hideUnhideCooldowns: {},
    buttonCooldowns: {},
    pendingCreations: {}
};

if (fs.existsSync(DATA_FILE)) {
    try {
        const loadedData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        voiceData = {
            ...voiceData,
            ...loadedData,
            joinOrder: loadedData.joinOrder || {},
            ownerLeftTime: loadedData.ownerLeftTime || {},
            hideUnhideCooldowns: loadedData.hideUnhideCooldowns || {},
            buttonCooldowns: loadedData.buttonCooldowns || {},
            pendingCreations: {}
        };
        console.log('📂 Data dimuat dari voice_data.json');
    } catch (e) {
        console.error('⚠️ Error loading data:', e.message);
    }
}

// Debounced save untuk mengurangi I/O operations
const debouncedSave = debounce(() => {
    try {
        // Buat backup sebelum save
        if (fs.existsSync(DATA_FILE)) {
            fs.copyFileSync(DATA_FILE, DATA_FILE + '.backup');
        }
        
        // Clone voiceData tapi exclude pendingCreations (karena ada Timeout object)
        const dataToSave = {
            owners: voiceData.owners,
            panelMessages: voiceData.panelMessages,
            cooldowns: voiceData.cooldowns,
            hiddenUsers: voiceData.hiddenUsers,
            joinOrder: voiceData.joinOrder,
            ownerLeftTime: voiceData.ownerLeftTime,
            hideUnhideCooldowns: voiceData.hideUnhideCooldowns,
            buttonCooldowns: voiceData.buttonCooldowns
            // TIDAK termasuk pendingCreations (ada Timeout object)
        };
        
        fs.writeFileSync(DATA_FILE, JSON.stringify(dataToSave, null, 2));
        console.log('💾 Data disimpan');
    } catch (e) {
        console.error('⛔ Error saving data:', e.message);
        
        // Restore dari backup jika save gagal
        if (fs.existsSync(DATA_FILE + '.backup')) {
            try {
                fs.copyFileSync(DATA_FILE + '.backup', DATA_FILE);
                console.log('❌ Data restored from backup');
            } catch (restoreError) {
                console.error('⛔ Failed to restore backup:', restoreError.message);
            }
        }
    }
}, 2000); // Save setiap 2 detik max

function saveData() {
    debouncedSave();
}

// ==========================================
// ASIA REGIONS
// ==========================================
const ASIA_REGIONS = [
    { label: '🇸🇬 Singapore', value: 'singapore' },
    { label: '🇯🇵 Japan', value: 'japan' },
    { label: '🇭🇰 Hong Kong', value: 'hongkong' },
    { label: '🇮🇳 India', value: 'india' },
    { label: '🇰🇷 South Korea', value: 'south-korea' }
];

// ==========================================
// COOLDOWN HELPERS
// ==========================================
function checkButtonCooldown(userId) {
    const now = Date.now();
    const lastUse = voiceData.buttonCooldowns[userId] || 0;
    const cooldownTime = Math.random() * (CONFIG.buttonCooldownMax - CONFIG.buttonCooldownMin) + CONFIG.buttonCooldownMin;
    
    if (now - lastUse < cooldownTime) {
        return { onCooldown: true, message: '⏳ Tunggu beberapa detik lagi sebelum menggunakan button!' };
    }
    
    voiceData.buttonCooldowns[userId] = now;
    saveData();
    return { onCooldown: false };
}

function checkHideUnhideCooldown(userId) {
    const now = Date.now();
    const lastUse = voiceData.hideUnhideCooldowns[userId] || 0;
    
    if (now - lastUse < CONFIG.hideUnhideCooldown) {
        const remainingSeconds = Math.ceil((CONFIG.hideUnhideCooldown - (now - lastUse)) / 1000);
        return { onCooldown: true, remaining: remainingSeconds };
    }
    
    voiceData.hideUnhideCooldowns[userId] = now;
    saveData();
    return { onCooldown: false };
}

// ==========================================
// PERMISSION HELPERS
// ==========================================
function hasVipRole(member) {
    if (!member) return false;
    return member.roles.cache.has(CONFIG.vipRole);
}

function hasPremiumRole(member) {
    if (!member) return false;
    return member.roles.cache.has(CONFIG.premium1Role) ||
           member.roles.cache.has(CONFIG.premium2Role);
}

function hasSpecialRole(member) {
    if (!member) return false;
    return member.roles.cache.has(CONFIG.adminRole) ||
           member.roles.cache.has(CONFIG.premium1Role) ||
           member.roles.cache.has(CONFIG.premium2Role) ||
           member.roles.cache.has(CONFIG.vipRole);
}

function isAdmin(member) {
    if (!member) return false;
    return member.roles.cache.has(CONFIG.adminRole);
}

function canAccessCategory(member, categoryConfig) {
    // Admin can access everything
    if (isAdmin(member)) return true;
    
    // VIP Lounge requires VIP role
    if (categoryConfig.requireVip) {
        return hasVipRole(member);
    }
    
    // Chill Lounges: Everyone can access (VIP, Premium, Regular)
    return true;
}

function canUseButton(member, buttonId, voiceChannel, categoryConfig) {
    const isOwner = voiceData.owners[voiceChannel.id] === member.id;
    
    // Admin can use everything (even if not owner)
    if (isAdmin(member)) return true;
    
    // Check category access first
    if (!canAccessCategory(member, categoryConfig)) return false;
    
    // VIP users: Full access BUT MUST BE OWNER
    if (hasVipRole(member)) {
        return isOwner;  // Changed: Must be owner
    }
    
    // Premium users: Full access in Chill Lounges BUT MUST BE OWNER
    if (hasPremiumRole(member)) {
        // Premium cannot access VIP Lounge
        if (categoryConfig.requireVip) return false;
        return isOwner;  // Changed: Must be owner
    }
    
    // Regular users: Only limit and region (owner only)
    if (['limit', 'region'].includes(buttonId)) {
        return isOwner;
    }
    
    return false;
}

// ==========================================
// JOIN ORDER HELPERS
// ==========================================
function addToJoinOrder(channelId, userId) {
    if (!voiceData.joinOrder[channelId]) {
        voiceData.joinOrder[channelId] = [];
    }
    
    voiceData.joinOrder[channelId] = voiceData.joinOrder[channelId].filter(
        entry => entry.userId !== userId
    );
    
    voiceData.joinOrder[channelId].push({
        userId: userId,
        timestamp: Date.now()
    });
    
    saveData();
    console.log(`📋 Join order updated for channel ${channelId}`);
}

function removeFromJoinOrder(channelId, userId) {
    if (!voiceData.joinOrder[channelId]) return;
    
    voiceData.joinOrder[channelId] = voiceData.joinOrder[channelId].filter(
        entry => entry.userId !== userId
    );
    
    saveData();
}

function getNextInLine(channelId, ownerId) {
    if (!voiceData.joinOrder[channelId] || voiceData.joinOrder[channelId].length === 0) {
        return null;
    }
    
    const nextUser = voiceData.joinOrder[channelId].find(entry => entry.userId !== ownerId);
    return nextUser ? nextUser.userId : null;
}

function canClaimVoice(channelId, userId) {
    const ownerId = voiceData.owners[channelId];
    if (!ownerId) return { canClaim: true, reason: 'No owner' };
    
    const ownerLeftTime = voiceData.ownerLeftTime[channelId];
    if (!ownerLeftTime) {
        return { canClaim: false, reason: 'Owner belum keluar dari voice' };
    }
    
    const timePassed = Date.now() - ownerLeftTime;
    if (timePassed < CONFIG.ownerLeaveDelay) {
        const remainingMinutes = Math.ceil((CONFIG.ownerLeaveDelay - timePassed) / 60000);
        return { 
            canClaim: false, 
            reason: `Owner baru keluar ${Math.floor(timePassed / 60000)} menit yang lalu. Tunggu ${remainingMinutes} menit lagi untuk claim.`
        };
    }
    
    const nextUserId = getNextInLine(channelId, ownerId);
    if (!nextUserId) {
        return { canClaim: false, reason: 'Tidak ada user dalam antrian' };
    }
    
    if (nextUserId !== userId) {
        return { 
            canClaim: false, 
            reason: `Hanya <@${nextUserId}> yang dapat claim voice ini (urutan berikutnya setelah owner)`
        };
    }
    
    return { canClaim: true, reason: 'OK' };
}

// ==========================================
// LOGGING SYSTEM
// ==========================================
// Throttled logging untuk mencegah spam
const sendLog = throttle(async (guild, action, data) => {
    if (!CONFIG.logEnabled || !CONFIG.logChannel) return;
    
    try {
        let logChannel = channelCache.get(CONFIG.logChannel);
        if (!logChannel) {
            logChannel = guild.channels.cache.get(CONFIG.logChannel);
            if (logChannel) channelCache.set(CONFIG.logChannel, logChannel);
        }
        if (!logChannel) {
            console.error('❌ Log channel tidak ditemukan:', CONFIG.logChannel);
            return;
        }
        
        const embed = new EmbedBuilder()
            .setColor('#9b59b6')
            .setTitle(`📝 Voice Action: ${action}`)
            .setTimestamp();
        
        Object.keys(data).forEach(key => {
            embed.addFields({ name: key, value: data[key].toString(), inline: true });
        });
        
        await logChannel.send({ embeds: [embed] });
        console.log(`📝 Log terkirim: ${action}`);
    } catch (e) {
        console.error('❌ Log error:', e.message);
    }
}, 3000); // Max 1 log per 3 detik

// ==========================================
// VOICE CHANNEL CREATION
// ==========================================
const creationQueue = new Map();

async function createVoiceChannel(member, category, generatorChannel) {
    console.log(`\n🎤 Membuat voice channel untuk: ${member.user.tag}`);
    const userId = member.id;
    const now = Date.now();
    
    // Check if user can access this category
    const categoryConfig = CONFIG.categories.find(c => c.id === category.id);
    if (categoryConfig && !canAccessCategory(member, categoryConfig)) {
        console.log(`❌ ${member.user.tag} tidak punya akses ke ${categoryConfig.name}`);
        try {
            await member.send(`❌ Kamu tidak memiliki akses untuk membuat voice di ${categoryConfig.name}!`).catch(() => {});
        } catch (e) {
            console.error('❌ Error sending DM:', e.message);
        }
        return null;
    }
    
// Check cooldown
if (voiceData.cooldowns[userId] && (now - voiceData.cooldowns[userId]) < 23000) {
    const remaining = Math.ceil((23000 - (now - voiceData.cooldowns[userId])) / 1000);
    const cooldownEndTime = voiceData.cooldowns[userId] + 23000;
    console.log(`⏳ ${member.user.tag} masih dalam cooldown: ${remaining}s`);
    
    try {
        // Send DM to user with timestamp
        const dmEmbed = new EmbedBuilder()
            .setColor('#FFA500')
            .setTitle('⏳ Voice Creation Cooldown')
            .setDescription(`Kamu masih dalam cooldown untuk membuat voice channel!\n\n` +
                           `✨ Tetap di voice generator, dan voice akan otomatis dibuat saat cooldown selesai!`)
            .addFields(
                { name: '⏱️ Sisa Waktu', value: `${remaining} detik`, inline: true },
                { name: '🕐 Bisa Buat Lagi', value: `<t:${Math.floor(cooldownEndTime)}:R>`, inline: true }
            )
            .setFooter({ text: 'Voice akan otomatis dibuat jika kamu tetap di generator' })
            .setTimestamp();
        
        await member.send({ embeds: [dmEmbed] }).catch(() => {
            console.log('⚠️ Tidak bisa mengirim DM ke user (DM mungkin tertutup)');
        });
    } catch (e) {
        console.error('❌ Error sending DM:', e.message);
    }
    
    try {
        // Send message to voice generator channel (open chat) and tag user
        if (generatorChannel && generatorChannel.isTextBased()) {
            const channelEmbed = new EmbedBuilder()
                .setColor('#FFA500')
                .setDescription(`⏳ ${member} masih dalam cooldown!\n\n` +
                               `**Sisa Waktu:** ${remaining} detik\n` +
                               `**Bisa Buat Voice Lagi:** <t:${Math.floor(cooldownEndTime / 1000)}:R>\n\n` +
                               `✨ *Tetap stay di generator, voice akan otomatis dibuat!*`)
                .setTimestamp();
            
            const cooldownMsg = await generatorChannel.send({ 
                content: `${member}`, // Tag user
                embeds: [channelEmbed] 
            });
            
            // Auto delete message after cooldown ends + 1 second
            setTimeout(async () => {
                try {
                    await cooldownMsg.delete();
                } catch (e) {
                    console.log('⚠️ Tidak bisa menghapus cooldown message');
                }
            }, (remaining * 1000) + 1000);
        }
    } catch (e) {
        console.error('❌ Error sending channel message:', e.message);
    }
    
    // Cancel any existing pending creation for this user
    if (voiceData.pendingCreations[userId]) {
        clearTimeout(voiceData.pendingCreations[userId].timeoutId);
        delete voiceData.pendingCreations[userId];  // ← TAMBAHKAN BARIS INI
        console.log(`🔄 Cancelled previous pending creation for ${member.user.tag}`);
    }
    
    // Schedule auto-creation when cooldown ends
    const timeoutId = setTimeout(async () => {
        try {
            console.log(`⏰ Cooldown ended for ${member.user.tag}, checking if still in generator...`);
            
            // Fetch fresh member data
            const freshMember = await member.guild.members.fetch(userId).catch(() => null);
            if (!freshMember) {
                console.log(`⚠️ Member ${member.user.tag} not found`);
                delete voiceData.pendingCreations[userId];
                return;
            }
            
            // Check if still in voice and in the same generator
            if (freshMember.voice.channel && freshMember.voice.channel.id === generatorChannel.id) {
                console.log(`✅ ${member.user.tag} still in generator, creating voice automatically...`);
                
                // Create voice channel
                await createVoiceChannel(freshMember, category, generatorChannel);
                
                // Send success notification
                if (generatorChannel.isTextBased()) {
                    const successEmbed = new EmbedBuilder()
                        .setColor('#00FF00')
                        .setDescription(`✅ ${freshMember} Voice channel berhasil dibuat otomatis!`)
                        .setTimestamp();
                    
                    const successMsg = await generatorChannel.send({ embeds: [successEmbed] });
                    
                    // Delete after 3 seconds
                    setTimeout(async () => {
                        try {
                            await successMsg.delete();
                        } catch (e) {
                            console.log('⚠️ Tidak bisa menghapus success message');
                        }
                    }, 3000);
                }
            } else {
                console.log(`⚠️ ${member.user.tag} tidak lagi di generator, batal auto-create`);
                
                // Send info if user left
                if (generatorChannel.isTextBased()) {
                    const cancelEmbed = new EmbedBuilder()
                        .setColor('#FF9900')
                        .setDescription(`⚠️ ${freshMember} Cooldown selesai tapi kamu sudah keluar dari generator.\n\nJoin lagi untuk membuat voice!`)
                        .setTimestamp();
                    
                    const cancelMsg = await generatorChannel.send({ embeds: [cancelEmbed] });
                    
                    // Delete after 3 seconds
                    setTimeout(async () => {
                        try {
                            await cancelMsg.delete();
                        } catch (e) {
                            console.log('⚠️ Tidak bisa menghapus cancel message');
                        }
                    }, 3000);
                }
            }
            
            // Clean up
            delete voiceData.pendingCreations[userId];
            
        } catch (e) {
            console.error('❌ Error in auto-creation timeout:', e.message);
            delete voiceData.pendingCreations[userId];
        }
    }, remaining * 1000);
    
    // Store the timeout
    voiceData.pendingCreations[userId] = {
        timeoutId: timeoutId,
        categoryId: category.id,
        generatorId: generatorChannel.id,
        scheduledTime: cooldownEndTime
    };
    
    console.log(`⏰ Scheduled auto-creation for ${member.user.tag} in ${remaining} seconds`);
    
    return null;
}
    
    // Use operation queue instead of manual delay
    return await operationQueue.add(`create_${category.id}`, async () => {
        const delay = 500 + Math.random() * 1000; // Reduced delay
        await new Promise(resolve => setTimeout(resolve, delay));
    
    creationQueue.set(category.id, true);
    
    try {
        console.log('📋 Menyalin permissions dari category...');
        const categoryPermissions = category.permissionOverwrites.cache.map(overwrite => ({
            id: overwrite.id,
            allow: overwrite.allow.bitfield,
            deny: overwrite.deny.bitfield,
            type: overwrite.type
        }));
        
        console.log('🔄 Membuat voice channel...');
        const voiceChannel = await category.children.create({
            name: `${member.displayName} Voice`,
            type: ChannelType.GuildVoice,
            permissionOverwrites: [
                ...categoryPermissions,
                {
                    id: member.id,
                    allow: [
                        PermissionFlagsBits.Connect,
                        PermissionFlagsBits.Speak,
                        PermissionFlagsBits.Stream,
                    ]
                }
            ]
        });
        console.log(`✅ Voice channel dibuat: ${voiceChannel.name}`);
        
        voiceData.owners[voiceChannel.id] = userId;
        voiceData.cooldowns[userId] = now;
        voiceData.hiddenUsers[voiceChannel.id] = [];
        voiceData.joinOrder[voiceChannel.id] = [{ userId: userId, timestamp: now }];
        delete voiceData.ownerLeftTime[voiceChannel.id];
        saveData();
        
        console.log('🚶 Memindahkan user ke voice channel...');
        await member.voice.setChannel(voiceChannel);
        
        // Set permission untuk open chat - hanya user di voice yang bisa lihat dan kirim pesan
        try {
            console.log('🔒 Setting up open chat permissions...');
    
            // Default: @everyone tidak bisa lihat dan kirim pesan
            await voiceChannel.permissionOverwrites.edit(voiceChannel.guild.roles.everyone, {
                ViewChannel: true,
                SendMessages: false,
                ReadMessageHistory: true
            });
    
            // Owner (yang baru join) bisa lihat dan kirim pesan
            await voiceChannel.permissionOverwrites.edit(member.id, {
                ViewChannel: true,
                SendMessages: true,
                ReadMessageHistory: true,
                Connect: true,
                Speak: true,
                Stream: true,
            });
    
            console.log('✅ Open chat permissions set');
        } catch (e) {
            console.error('❌ Error setting open chat permissions:', e.message);
        }

        try {
            await voiceChannel.send(`👋 Selamat datang ${member}! Gunakan panel kontrol di text channel untuk mengatur voice ini.`);
        } catch (e) {
            console.log('⚠️ Voice channel tidak support text chat atau bot tidak punya permission');
        }
        
        await sendLog(category.guild, 'Voice Created', {
            'User': member.toString(),
            'Channel': voiceChannel.name,
            'Category': category.name
        });
        
        console.log('✅ Voice channel berhasil dibuat!\n');
        return voiceChannel;
        
        } catch (e) {
            console.error('❌ Error membuat voice channel:', e.message);
            console.error('Stack:', e.stack);
            
            try {
                await member.send('❌ Gagal membuat voice channel! Coba lagi atau hubungi admin.').catch(() => {});
            } catch (notifyError) {
                console.error('❌ Gagal notifikasi user:', notifyError.message);
            }
            
            return null;
        }
    });
}

// ==========================================
// AUTO DELETE VOICE
// ==========================================
    async function deleteVoiceChannel(voiceChannel) {
        // Use operation queue untuk mencegah race condition
        return await operationQueue.add(`delete_${voiceChannel.id}`, async () => {
            const delay = 1000 + Math.random() * 1000; // Reduced delay
            await new Promise(resolve => setTimeout(resolve, delay));
    
    try {
        const freshChannel = await voiceChannel.guild.channels.fetch(voiceChannel.id).catch(() => null);
        if (!freshChannel) {
            console.log('⚠️ Channel sudah tidak ada');
            return;
        }
        
        const members = freshChannel.members.filter(m => !m.user.bot);
        if (members.size > 0) {
            console.log('⚠️ Channel masih ada member, batal delete');
            return;
        }
        
        console.log(`♻️ Menghapus voice channel: ${freshChannel.name}`);
        
        await freshChannel.delete();
        delete voiceData.owners[freshChannel.id];
        delete voiceData.hiddenUsers[freshChannel.id];
        delete voiceData.joinOrder[freshChannel.id];
        delete voiceData.ownerLeftTime[freshChannel.id];
        saveData();
        
        console.log('✅ Channel berhasil dihapus\n');
        
        await sendLog(freshChannel.guild, 'Voice Deleted', {
            'Channel': freshChannel.name,
            'Reason': 'Empty channel'
        });

    } catch (e) {
        console.error('❌ Error menghapus voice:', e.message);
        console.error('Stack:', e.stack);
    }
    });
}

// ==========================================
// CONTROL PANEL
// ==========================================
function createControlPanel() {
    const embed = new EmbedBuilder()
        .setColor('#9b59b6')
        .setTitle('🎙️ Voice Channel Control Panel')
        .setDescription('**Fungsi Tombol:**\n\n' +
            '🏷️ **Rename** - Ubah nama voice channel \n' +
            '🔒 **Lock** - Kunci voice \n' +
            '🔓 **Unlock** - Buka kunci voice\n' +
            '👢 **Kick** - Keluarkan member dari voice \n' +
            '👥 **Limit** - Atur batas jumlah member \n' +
            '🌏 **Region** - Ubah region server voice \n' +
            '✋ **Claim** - Klaim ownership voice \n' +
            '📤 **Transfer** - Transfer ownership ke member lain \n' +
            '👻 **Hide** - Sembunyikan user dari voice \n' +
            '👁️ **Unhide** - Tampilkan kembali user yang disembunyikan \n\n' +
            '***NOTED:***\n' +
            '• Hide user berdasarkan user di server \n' +
            '• Claim voice hanya bisa setelah owner keluar 30 menit\n'
        )
        .setFooter({ text: 'Hanya bisa digunakan saat berada di voice channel' })
        .setTimestamp();
    
    const row1 = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder().setCustomId('rename').setLabel('Rename').setEmoji('🏷️').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('lock').setLabel('Lock').setEmoji('🔒').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('unlock').setLabel('Unlock').setEmoji('🔓').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('kick').setLabel('Kick').setEmoji('👢').setStyle(ButtonStyle.Secondary)
        );
    
    const row2 = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder().setCustomId('limit').setLabel('Limit').setEmoji('👥').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('region').setLabel('Region').setEmoji('🌏').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('claim').setLabel('Claim').setEmoji('✋').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('transfer').setLabel('Transfer').setEmoji('📤').setStyle(ButtonStyle.Secondary)
        );
    
    const row3 = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder().setCustomId('hide').setLabel('Hide').setEmoji('👻').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('unhide').setLabel('Unhide').setEmoji('👁️').setStyle(ButtonStyle.Secondary)
        );
    
    return { embeds: [embed], components: [row1, row2, row3] };
}

// ==========================================
// SEND/SYNC PANELS
// ==========================================
async function sendOrSyncPanels(guild) {
    console.log('\n📤 Memulai proses pengiriman/sinkronisasi panel...\n');
    
    for (const cat of CONFIG.categories) {
        console.log(`🔍 Memproses category: ${cat.name}`);
        
        try {
            const panelChannel = guild.channels.cache.get(cat.panel);
            
            if (!panelChannel) {
                console.error(`❌ Panel channel tidak ditemukan: ${cat.panel}`);
                continue;
            }
            
            console.log(`✅ Panel channel ditemukan: ${panelChannel.name}`);
            
            const botPermissions = panelChannel.permissionsFor(guild.members.me);
            const requiredPermissions = [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.EmbedLinks
            ];
            
            const missingPermissions = requiredPermissions.filter(perm => !botPermissions.has(perm));
            
            if (missingPermissions.length > 0) {
                console.error(`❌ Bot tidak punya permission yang diperlukan di ${panelChannel.name}`);
                continue;
            }
            
            let panelMessage = null;
            if (voiceData.panelMessages[cat.id]) {
                try {
                    panelMessage = await panelChannel.messages.fetch(voiceData.panelMessages[cat.id]);
                } catch (e) {
                    console.log(`⚠️ Panel message lama tidak ditemukan`);
                }
            }
            
            if (panelMessage) {
                await panelMessage.edit(createControlPanel());
                console.log(`✅ Panel di-update untuk ${cat.name}\n`);
            } else {
                const panel = createControlPanel();
                const newPanel = await panelChannel.send(panel);
                voiceData.panelMessages[cat.id] = newPanel.id;
                saveData();
                console.log(`✅ Panel dibuat untuk ${cat.name}\n`);
            }
        } catch (e) {
            console.error(`❌ Error mengirim/update panel untuk ${cat.name}:`, e.message);
        }
    }
    
    console.log('📤 Proses panel selesai!\n');
}

// ==========================================
// BUTTON INTERACTIONS
// ==========================================
async function handleButtonInteraction(interaction) {
    console.log(`\n🖱️ Button clicked: ${interaction.customId} by ${interaction.user.tag}`)

    const rateLimitKey = `interaction_${interaction.user.id}`;
    const lastInteraction = voiceData.buttonCooldowns[rateLimitKey];
    if (lastInteraction && Date.now() - lastInteraction < 500) {
        return await interaction.reply({ 
            content: '⏳ Terlalu cepat! Tunggu sebentar.', 
            ephemeral: true 
        }).catch(() => {});
    }
    voiceData.buttonCooldowns[rateLimitKey] = Date.now();
    
    try {
        const member = interaction.member;
        const voiceState = member.voice;
        
        // Check button cooldown (kecuali untuk hide dan unhide yang punya cooldown sendiri)
        if (!['hide', 'unhide'].includes(interaction.customId)) {
            const cooldownCheck = checkButtonCooldown(member.id);
            if (cooldownCheck.onCooldown) {
                return await interaction.reply({ content: cooldownCheck.message, ephemeral: true });
            }
        }
        
        if (!voiceState.channel) {
            return await interaction.reply({ content: '❌ Kamu harus berada di voice channel!', ephemeral: true });
        }
        
        const voiceChannel = voiceState.channel;
        const category = voiceChannel.parent;
        
        if (!category) {
            return await interaction.reply({ content: '❌ Voice channel tidak valid!', ephemeral: true });
        }
        
        const categoryConfig = CONFIG.categories.find(c => c.id === category.id);
        if (!categoryConfig) {
            return await interaction.reply({ content: '❌ Voice channel tidak valid!', ephemeral: true });
        }
        
        const ownerId = voiceData.owners[voiceChannel.id];
        if (!ownerId) {
            return await interaction.reply({ content: '❌ Voice channel tidak memiliki owner!', ephemeral: true });
        }
        
        if (!canUseButton(member, interaction.customId, voiceChannel, categoryConfig)) {
    console.log(`❌ User tidak punya permission untuk button ini`);
    
    const isOwner = voiceData.owners[voiceChannel.id] === member.id;
    const isRegularUser = !isAdmin(member) && !hasVipRole(member) && !hasPremiumRole(member);
    const buttonId = interaction.customId;
    
    // Admin always passes canUseButton, so if we're here, user is NOT admin
    
    // Check if user is VIP or Premium but not owner
    if ((hasVipRole(member) || hasPremiumRole(member)) && !isOwner) {
        return await interaction.reply({ 
            content: '❌ Kamu bukan owner dari voice channel ini!\n\n' +
                     '👑 Hanya owner voice yang dapat menggunakan panel kontrol.', 
            ephemeral: true 
        });
    }
    
    // Check if Premium trying to access VIP Lounge
    if (hasPremiumRole(member) && categoryConfig.requireVip) {
        return await interaction.reply({ 
            content: '❌ premium user & no premium user tidak dapat mengakses VIP Lounge!', 
            ephemeral: true 
        });
    }
    
    // Regular user specific messages
    if (isRegularUser) {
        if (!isOwner) {
            return await interaction.reply({ 
                content: '❌ Kamu bukan owner dari voice channel ini!\n\n' +
                         '👑 Hanya owner voice yang dapat menggunakan panel kontrol.\n' +
                         '💡 Upgrade ke Premium atau VIP untuk akses fitur lengkap.', 
                ephemeral: true 
            });
        }
        
        // Regular user is owner but using wrong button
        if (!['limit', 'region'].includes(buttonId)) {
            return await interaction.reply({ 
                content: '❌ Sebagai user biasa, kamu hanya dapat menggunakan button **Limit** dan **Region**!\n\n' +
                         '💡 Upgrade ke Premium atau VIP untuk akses fitur lengkap.', 
                ephemeral: true 
            });
        }
    }
    
    // Generic fallback
    return await interaction.reply({ 
        content: '❌ Kamu tidak memiliki akses untuk tombol ini!', 
        ephemeral: true 
    });
}
    
        const buttonId = interaction.customId;
        
        switch (buttonId) {
            case 'rename': {
                try {
                    const modal = new ModalBuilder()
                        .setCustomId('rename_modal')
                        .setTitle('Rename Voice Channel');
                    
                    const nameInput = new TextInputBuilder()
                        .setCustomId('new_name')
                        .setLabel('Nama Baru Voice Channel')
                        .setStyle(TextInputStyle.Short)
                        .setPlaceholder('Masukkan nama baru (1-100 karakter)')
                        .setRequired(true)
                        .setMinLength(1)
                        .setMaxLength(100);
                    
                    const row = new ActionRowBuilder().addComponents(nameInput);
                    modal.addComponents(row);
                    
                    await interaction.showModal(modal);
                } catch (e) {
                    console.error('❌ Error showing modal:', e.message);
                    await interaction.reply({ content: '❌ Gagal menampilkan form!', ephemeral: true }).catch(() => {});
                }
                break;
            }
            
            case 'lock': {
                try {
                    const currentMembers = voiceChannel.members.map(m => m.id);
                    await voiceChannel.permissionOverwrites.edit(interaction.guild.roles.everyone, {
                        Connect: false
                    });
                    
                    for (const memberId of currentMembers) {
                        try {
                            await voiceChannel.permissionOverwrites.edit(memberId, {
                                Connect: true
                            });
                        } catch (e) {
                            console.error(`❌ Error setting permission for member ${memberId}:`, e.message);
                        }
                    }
                    
                    await interaction.reply({ content: '🔒 Voice channel dikunci!', ephemeral: true });
                    
                    await sendLog(interaction.guild, 'Voice Locked', {
                        'User': member.toString(),
                        'Channel': voiceChannel.name
                    });
                } catch (e) {
                    console.error('❌ Error lock:', e.message);
                    await interaction.reply({ content: '❌ Gagal mengunci voice!', ephemeral: true }).catch(() => {});
                }
                break;
            }
            
            case 'unlock': {
                try {
                    await voiceChannel.permissionOverwrites.delete(interaction.guild.roles.everyone);
                    await interaction.reply({ content: '🔓 Voice channel dibuka!', ephemeral: true });
                    
                    await sendLog(interaction.guild, 'Voice Unlocked', {
                        'User': member.toString(),
                        'Channel': voiceChannel.name
                    });
                } catch (e) {
                    console.error('❌ Error unlock:', e.message);
                    await interaction.reply({ content: '❌ Gagal membuka voice!', ephemeral: true }).catch(() => {});
                }
                break;
            }
            
            case 'kick': {
                try {
                    const kickableMembers = voiceChannel.members.filter(m => 
                        m.id !== member.id && !m.user.bot && m.id !== ownerId
                    );
                    
                    if (kickableMembers.size === 0) {
                        return await interaction.reply({ content: '❌ Tidak ada member yang bisa di-kick!', ephemeral: true });
                    }
                    
                    const options = kickableMembers.map(m => ({
                        label: m.user.username,
                        description: m.displayName,
                        value: m.id
                    })).slice(0, 25);
                    
                    const selectMenu = new StringSelectMenuBuilder()
                        .setCustomId('kick_select')
                        .setPlaceholder('Pilih user untuk di-kick...')
                        .addOptions(options);
                    
                    const row = new ActionRowBuilder().addComponents(selectMenu);
                    
                    await interaction.reply({
                        content: '👢 Pilih user yang ingin di-kick:',
                        components: [row],
                        ephemeral: true
                    });
                } catch (e) {
                    console.error('❌ Error kick menu:', e.message);
                    await interaction.reply({ content: '❌ Gagal menampilkan menu!', ephemeral: true }).catch(() => {});
                }
                break;
            }
            
            case 'limit': {
                try {
                    const modal = new ModalBuilder()
                        .setCustomId('limit_modal')
                        .setTitle('Set User Limit');
                    
                    const limitInput = new TextInputBuilder()
                        .setCustomId('limit_value')
                        .setLabel('Batas Jumlah Member')
                        .setStyle(TextInputStyle.Short)
                        .setPlaceholder('0-99 (0 = unlimited)')
                        .setRequired(true)
                        .setMinLength(1)
                        .setMaxLength(2);
                    
                    const row = new ActionRowBuilder().addComponents(limitInput);
                    modal.addComponents(row);
                    
                    await interaction.showModal(modal);
                } catch (e) {
                    console.error('❌ Error showing modal:', e.message);
                    await interaction.reply({ content: '❌ Gagal menampilkan form!', ephemeral: true }).catch(() => {});
                }
                break;
            }
            
            case 'region': {
                try {
                    const regionMenu = new StringSelectMenuBuilder()
                        .setCustomId('region_select')
                        .setPlaceholder('Pilih region...')
                        .addOptions(ASIA_REGIONS.map(region => ({
                            label: region.label,
                            value: region.value
                        })));
                    
                    const row = new ActionRowBuilder().addComponents(regionMenu);
                    
                    await interaction.reply({
                        content: '🌏 Pilih region:',
                        components: [row],
                        ephemeral: true
                    });
                } catch (e) {
                    console.error('❌ Error region menu:', e.message);
                    await interaction.reply({ content: '❌ Gagal menampilkan menu!', ephemeral: true }).catch(() => {});
                }
                break;
            }
            
            case 'claim': {
                try {
                    // Get the previous owner info
                    const previousOwnerId = voiceData.owners[voiceChannel.id];
                    let owner = memberCache.get(previousOwnerId);  // ← GANTI selectedId dengan previousOwnerId
                    
                    if (!owner) {
                        owner = await interaction.guild.members.fetch(previousOwnerId).catch(() => null);
                        if (owner) memberCache.set(previousOwnerId, owner);
                    }
                    
                    if (isAdmin(member)) {
                        voiceData.owners[voiceChannel.id] = member.id;
                        delete voiceData.ownerLeftTime[voiceChannel.id];
                        saveData();
                        await interaction.reply({ content: '✅ Ownership berhasil di-claim (force admin)!', ephemeral: true });
                        
                        await sendLog(interaction.guild, 'Voice Claimed (Force)', {
                            'By': member.toString(),
                            'Channel': voiceChannel.name,
                            'Previous Owner': owner?.toString() || 'Unknown'
                        });
                        return;
                    }
                    
                    if (owner && owner.voice.channel?.id === voiceChannel.id) {
                        return await interaction.reply({ content: '❌ Owner masih berada di voice!', ephemeral: true });
                    }
                    
                    const claimCheck = canClaimVoice(voiceChannel.id, member.id);
                    
                    if (!claimCheck.canClaim) {
                        return await interaction.reply({ 
                            content: `❌ ${claimCheck.reason}`, 
                            ephemeral: true 
                        });
                    }
                    
                    voiceData.owners[voiceChannel.id] = member.id;
                    delete voiceData.ownerLeftTime[voiceChannel.id];
                    saveData();
                    await interaction.reply({ content: '✅ Ownership berhasil di-claim!', ephemeral: true });
                    
                    await sendLog(interaction.guild, 'Voice Claimed', {
                        'By': member.toString(),
                        'Channel': voiceChannel.name,
                        'Previous Owner': owner?.toString() || 'Unknown'
                    });
                } catch (e) {
                    console.error('❌ Error claim:', e.message);
                    await interaction.reply({ content: '❌ Gagal claim ownership!', ephemeral: true }).catch(() => {});
                }
                break;
            }
            
            case 'transfer': {
                try {
                    const transferableMembers = voiceChannel.members.filter(m => 
                        m.id !== member.id && !m.user.bot
                    );
                    
                    if (transferableMembers.size === 0) {
                        return await interaction.reply({ content: '❌ Tidak ada member yang bisa di-transfer ownership!', ephemeral: true });
                    }
                    
                    const options = transferableMembers.map(m => ({
                        label: m.user.username,
                        description: m.displayName,
                        value: m.id
                    })).slice(0, 25);
                    
                    const selectMenu = new StringSelectMenuBuilder()
                        .setCustomId('transfer_select')
                        .setPlaceholder('Pilih user untuk transfer ownership...')
                        .addOptions(options);
                    
                    const row = new ActionRowBuilder().addComponents(selectMenu);
                    
                    await interaction.reply({
                        content: '📤 Pilih user untuk transfer ownership:',
                        components: [row],
                        ephemeral: true
                    });
                } catch (e) {
                    console.error('❌ Error transfer menu:', e.message);
                    await interaction.reply({ content: '❌ Gagal menampilkan menu!', ephemeral: true }).catch(() => {});
                }
                break;
            }
            
            case 'hide': {
                try {
                    // Check hide/unhide cooldown
                    const cooldownCheck = checkHideUnhideCooldown(member.id);
                    if (cooldownCheck.onCooldown) {
                        return await interaction.reply({ 
                            content: `⏳ Tunggu beberapa detik lagi sebelum menggunakan hide! (${cooldownCheck.remaining} detik)`, 
                            ephemeral: true 
                        });
                    }
                    
                    const currentHidden = voiceData.hiddenUsers[voiceChannel.id] || [];
                    if (currentHidden.length >= CONFIG.maxHiddenUsers) {
                        return await interaction.reply({ 
                            content: `❌ Maksimal ${CONFIG.maxHiddenUsers} user dapat di-hide! Unhide user lain terlebih dahulu.`, 
                            ephemeral: true 
                        });
                    }
                    
                    const modal = new ModalBuilder()
                        .setCustomId('hide_modal')
                        .setTitle('Hide User dari Voice');
                    
                    const usernameInput = new TextInputBuilder()
                        .setCustomId('username')
                        .setLabel('Username yang ingin di-hide')
                        .setStyle(TextInputStyle.Short)
                        .setPlaceholder('Masukkan username Discord (tanpa #)')
                        .setRequired(true)
                        .setMinLength(2)
                        .setMaxLength(32);
                    
                    const row = new ActionRowBuilder().addComponents(usernameInput);
                    modal.addComponents(row);
                    
                    await interaction.showModal(modal);
                } catch (e) {
                    console.error('❌ Error hide modal:', e.message);
                    await interaction.reply({ content: '❌ Gagal menampilkan form!', ephemeral: true }).catch(() => {});
                }
                break;
            }
            
            case 'unhide': {
                try {
                    // Check hide/unhide cooldown
                    const cooldownCheck = checkHideUnhideCooldown(member.id);
                    if (cooldownCheck.onCooldown) {
                        return await interaction.reply({ 
                            content: `⏳ Tunggu beberapa detik lagi sebelum menggunakan unhide! (${cooldownCheck.remaining} detik)`, 
                            ephemeral: true 
                        });
                    }
                    
                    const hiddenUsers = voiceData.hiddenUsers[voiceChannel.id] || [];
                    
                    if (hiddenUsers.length === 0) {
                        return await interaction.reply({ content: '❌ Tidak ada user yang disembunyikan!', ephemeral: true });
                    }
                    
                    const options = [];
                    for (const userId of hiddenUsers) {
                        try {
                            const hiddenMember = await interaction.guild.members.fetch(userId);
                            options.push({
                                label: hiddenMember.user.username,
                                description: hiddenMember.displayName,
                                value: userId
                            });
                        } catch (e) {
                            console.error(`⚠️ Hidden user ${userId} tidak ditemukan`);
                        }
                    }
                    
                    if (options.length === 0) {
                        return await interaction.reply({ content: '❌ Tidak ada user yang bisa di-unhide!', ephemeral: true });
                    }
                    
                    const selectMenu = new StringSelectMenuBuilder()
                        .setCustomId('unhide_select')
                        .setPlaceholder('Pilih user untuk ditampilkan kembali...')
                        .addOptions(options.slice(0, 25));
                    
                    const row = new ActionRowBuilder().addComponents(selectMenu);
                    
                    await interaction.reply({
                        content: '👁️ Pilih user yang ingin ditampilkan kembali:',
                        components: [row],
                        ephemeral: true
                    });
                } catch (e) {
                    console.error('❌ Error unhide menu:', e.message);
                    await interaction.reply({ content: '❌ Gagal menampilkan menu!', ephemeral: true }).catch(() => {});
                }
                break;
            }
            
            default:
                await interaction.reply({ content: '❌ Button tidak dikenali!', ephemeral: true });
        }
    } catch (e) {
        console.error('❌ Error handling button interaction:', e.message);
        console.error('Stack:', e.stack);
        
        try {
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({ content: '❌ Terjadi error! Coba lagi atau hubungi admin.', ephemeral: true });
            }
        } catch (replyError) {
            console.error('❌ Error sending error message:', replyError.message);
        }
    }
}

// ==========================================
// MODAL SUBMIT HANDLER
// ==========================================
async function handleModalSubmit(interaction) {
    console.log(`\n📝 Modal submitted: ${interaction.customId} by ${interaction.user.tag}`);
    
    try {
        const member = interaction.member;
        const voiceState = member.voice;
        
        if (!voiceState.channel) {
            return await interaction.reply({ content: '❌ Kamu harus berada di voice channel!', ephemeral: true });
        }
        
        const voiceChannel = voiceState.channel;
        
        if (interaction.customId === 'rename_modal') {
            let newName = interaction.fields.getTextInputValue('new_name').trim();
            
            // Validasi panjang nama
            if (newName.length === 0) {
                return await interaction.reply({ 
                    content: '❌ Nama tidak boleh kosong!', 
                    ephemeral: true 
                });
            }
            
            if (newName.length > 96) {
                newName = newName.slice(0, 96);
                console.log(`⚠️ Nama dipotong ke 96 character`);
            }
            
            try {
                await voiceChannel.setName(newName);
                await interaction.reply({ content: `✅ Nama diubah menjadi: ${newName}`, ephemeral: true });
                
                await sendLog(interaction.guild, 'Voice Renamed', {
                    'User': member.toString(),
                    'New Name': newName,
                    'Channel ID': voiceChannel.id
                });
            } catch (e) {
                console.error('❌ Error rename:', e.message);
                await interaction.reply({ content: '❌ Gagal rename channel!', ephemeral: true });
            }
        } else if (interaction.customId === 'limit_modal') {
            const limitStr = interaction.fields.getTextInputValue('limit_value');
            const limit = parseInt(limitStr);
            
            if (isNaN(limit) || limit < 0 || limit > 99) {
                return await interaction.reply({ content: '❌ Angka tidak valid! Harus 0-99.', ephemeral: true });
            }
            
            try {
                await voiceChannel.setUserLimit(limit);
                await interaction.reply({ 
                    content: `✅ Limit diatur ke: ${limit === 0 ? 'Unlimited' : limit}`, 
                    ephemeral: true 
                });
                
                await sendLog(interaction.guild, 'Limit Changed', {
                    'User': member.toString(),
                    'Channel': voiceChannel.name,
                    'Limit': limit.toString()
                });
            } catch (e) {
                console.error('❌ Error limit:', e.message);
                await interaction.reply({ content: '❌ Gagal set limit!', ephemeral: true });
            }
        } else if (interaction.customId === 'hide_modal') {
            const username = interaction.fields.getTextInputValue('username').trim();
            
            try {
                const currentHidden = voiceData.hiddenUsers[voiceChannel.id] || [];
                if (currentHidden.length >= CONFIG.maxHiddenUsers) {
                    return await interaction.reply({ 
                        content: `❌ Maksimal ${CONFIG.maxHiddenUsers} user dapat di-hide!`, 
                        ephemeral: true 
                    });
                }
                
                // Cari user di SERVER (bukan hanya di voice)
                const targetMember = await interaction.guild.members.fetch()
                    .then(members => members.find(m => 
                        m.user.username.toLowerCase() === username.toLowerCase() ||
                        m.displayName.toLowerCase() === username.toLowerCase()
                    ))
                    .catch(() => null);
                
                if (!targetMember) {
                    return await interaction.reply({ 
                        content: `❌ Username "${username}" tidak ditemukan di server ini! Pastikan username benar.`, 
                        ephemeral: true 
                    });
                }
                
                const ownerId = voiceData.owners[voiceChannel.id];
                if (targetMember.id === ownerId) {
                    return await interaction.reply({ 
                        content: '❌ Tidak dapat hide owner!', 
                        ephemeral: true 
                    });
                }
                
                if (targetMember.user.bot) {
                    return await interaction.reply({ 
                        content: '❌ Tidak dapat hide bot!', 
                        ephemeral: true 
                    });
                }
                
                if (currentHidden.includes(targetMember.id)) {
                    return await interaction.reply({ 
                        content: `❌ ${targetMember.user.username} sudah di-hide!`, 
                        ephemeral: true 
                    });
                }
                
                // Hide user
                await voiceChannel.permissionOverwrites.edit(targetMember.id, {
                    ViewChannel: false,
                    Connect: false,
                    SendMessages: false,
                    ReadMessageHistory: false
                });
                
                // Kick jika user ada di voice
                if (targetMember.voice.channel?.id === voiceChannel.id) {
                    await targetMember.voice.disconnect().catch(() => {});
                }
                
                if (!voiceData.hiddenUsers[voiceChannel.id]) {
                    voiceData.hiddenUsers[voiceChannel.id] = [];
                }
                voiceData.hiddenUsers[voiceChannel.id].push(targetMember.id);
                saveData();
                
                await interaction.reply({ 
                    content: `✅ ${targetMember.user.username} berhasil disembunyikan dari voice! (${currentHidden.length}/${CONFIG.maxHiddenUsers})`, 
                    ephemeral: true 
                });
                
                await sendLog(interaction.guild, 'User Hidden (Server)', {
                    'By': member.toString(),
                    'User': targetMember.toString(),
                    'Channel': voiceChannel.name,
                    'Username Input': username
                });
            } catch (e) {
                console.error('❌ Error hide by username:', e.message);
                await interaction.reply({ content: '❌ Gagal hide user!', ephemeral: true });
            }
        }
    } catch (e) {
        console.error('❌ Error handling modal:', e.message);
        await interaction.reply({ content: '❌ Terjadi error!', ephemeral: true }).catch(() => {});
    }
}

// ==========================================
// SELECT MENU HANDLER
// ==========================================
async function handleSelectMenu(interaction) {
    console.log(`\n📋 Select menu: ${interaction.customId} by ${interaction.user.tag}`);
    
    try {
        const member = interaction.member;
        const voiceState = member.voice;
        
        if (!voiceState.channel) {
            return await interaction.update({ content: '❌ Kamu harus berada di voice channel!', components: [] });
        }
        
        const voiceChannel = voiceState.channel;
        const selectedId = interaction.values[0];
        
        if (interaction.customId === 'kick_select') {
            let kickMember = memberCache.get(selectedId);
            if (!kickMember) {
                kickMember = await interaction.guild.members.fetch(selectedId).catch(() => null);
                if (kickMember) memberCache.set(selectedId, kickMember);
            }
            
            if (!kickMember) {
                return await interaction.update({ content: '❌ User tidak ditemukan!', components: [] });
            }
            
            if (!kickMember.voice.channel || kickMember.voice.channel.id !== voiceChannel.id) {
                return await interaction.update({ content: '❌ User sudah tidak berada di voice channel!', components: [] });
            }
            
            try {
                await kickMember.voice.disconnect();
                await interaction.update({ content: `✅ ${kickMember} telah di-kick!`, components: [] });
                
                await sendLog(interaction.guild, 'User Kicked', {
                    'By': member.toString(),
                    'User': kickMember.toString(),
                    'Channel': voiceChannel.name
                });
            } catch (e) {
                console.error('❌ Error kick:', e.message);
                await interaction.update({ content: '❌ Gagal kick user!', components: [] });
            }
        } else if (interaction.customId === 'region_select') {
            const selectedRegion = selectedId;
            
            try {
                await voiceChannel.setRTCRegion(selectedRegion);
                const regionLabel = ASIA_REGIONS.find(r => r.value === selectedRegion)?.label;
                await interaction.update({ content: `✅ Region diubah ke: ${regionLabel}`, components: [] });
                
                await sendLog(interaction.guild, 'Region Changed', {
                    'User': member.toString(),
                    'Channel': voiceChannel.name,
                    'Region': regionLabel
                });
            } catch (e) {
                console.error('❌ Error region:', e.message);
                await interaction.update({ content: '❌ Gagal ubah region!', components: [] });
            }
        } else if (interaction.customId === 'transfer_select') {
            let transferMember = memberCache.get(selectedId);
            if (!transferMember) {
                transferMember = await interaction.guild.members.fetch(selectedId).catch(() => null);
                if (transferMember) memberCache.set(selectedId, transferMember);
            }
            
            if (!transferMember) {
                return await interaction.update({ content: '❌ User tidak ditemukan!', components: [] });
            }
            
            if (!transferMember.voice.channel || transferMember.voice.channel.id !== voiceChannel.id) {
                return await interaction.update({ content: '❌ User sudah tidak berada di voice channel!', components: [] });
            }
            
            try {
                voiceData.owners[voiceChannel.id] = selectedId;
                delete voiceData.ownerLeftTime[voiceChannel.id];
                saveData();
                await interaction.update({ content: `✅ Ownership di-transfer ke ${transferMember}!`, components: [] });
                
                await sendLog(interaction.guild, 'Ownership Transferred', {
                    'From': member.toString(),
                    'To': transferMember.toString(),
                    'Channel': voiceChannel.name
                });
            } catch (e) {
                console.error('❌ Error transfer:', e.message);
                await interaction.update({ content: '❌ Gagal transfer ownership!', components: [] });
            }
        } else if (interaction.customId === 'unhide_select') {
            let unhideMember = memberCache.get(selectedId);
            if (!unhideMember) {
                unhideMember = await interaction.guild.members.fetch(selectedId).catch(() => null);
                if (unhideMember) memberCache.set(selectedId, unhideMember);
            }
            
            if (!unhideMember) {
                return await interaction.update({ content: '❌ User tidak ditemukan!', components: [] });
            }
            
            try {
                const hiddenUsers = voiceData.hiddenUsers[voiceChannel.id] || [];
                voiceData.hiddenUsers[voiceChannel.id] = hiddenUsers.filter(id => id !== selectedId);
                saveData();
                
                // Check if user is currently in voice
                const isInVoice = unhideMember.voice.channel?.id === voiceChannel.id;
                
                if (isInVoice) {
                    // User is in voice, give them normal permissions
                    await voiceChannel.permissionOverwrites.edit(selectedId, {
                        ViewChannel: true,
                        Connect: true,
                        SendMessages: true,
                        ReadMessageHistory: true
                    });
                    invalidateMemberCache(selectedId);
                    invalidateChannelCache(voiceChannel.id);
                    console.log(`✅ ${unhideMember.user.tag} unhidden and in voice - permissions restored`);
                } else {
                    // User not in voice, just remove the overwrite
                    await voiceChannel.permissionOverwrites.delete(selectedId);
                    console.log(`✅ ${unhideMember.user.tag} unhidden but not in voice - permissions removed`);
                }
                
                await interaction.update({ content: `✅ ${unhideMember} ditampilkan kembali!`, components: [] });
                
                await sendLog(interaction.guild, 'User Unhidden', {
                    'By': member.toString(),
                    'User': unhideMember.toString(),
                    'Channel': voiceChannel.name
                });
            } catch (e) {
                console.error('❌ Error unhide:', e.message);
                await interaction.update({ content: '❌ Gagal unhide user!', components: [] });
            }
        }
    } catch (e) {
        console.error('❌ Error handling select menu:', e.message);
        await interaction.update({ content: '❌ Terjadi error!', components: [] }).catch(() => {});
    }
}

// ==========================================
// EVENT: READY
// ==========================================
client.once('ready', async () => {
    console.log('\n' + '='.repeat(50));
    console.log('🤖 BOT BERHASIL ONLINE!');
    console.log('='.repeat(50));
    console.log(`📛 Nama Bot: ${client.user.tag}`);
    console.log(`🆔 Bot ID: ${client.user.id}`);
    console.log(`📊 Server Count: ${client.guilds.cache.size}`);
    console.log('='.repeat(50));

    try {
        await startKeepAlive();
        console.log('✅ Keep-Alive system initialized\n');
    } catch (error) {
        console.error('❌ Failed to start Keep-Alive:', error.message);
        console.error('⚠️  Bot will still run but may sleep on Digital Ocean\n');
    }
    
    voiceData.pendingCreations = {};
    console.log('⏰ Restoring pending voice creations from previous session...');
    const now = Date.now();
    let restoredCount = 0;
    
    if (voiceData.pendingCreations && Object.keys(voiceData.pendingCreations).length > 0) {
        for (const [userId, pending] of Object.entries(voiceData.pendingCreations)) {
            const remainingTime = pending.scheduledTime - now;
            
            if (remainingTime > 0 && remainingTime < 3600000) { // Less than 1 hour remaining
                console.log(`⏳ Restoring pending creation for user ${userId} (${Math.ceil(remainingTime / 1000)}s remaining)`);
                
                // Reschedule the timeout
                const timeoutId = setTimeout(async () => {
                    try {
                        const guild = client.guilds.cache.find(g => {
                            const categoryConfig = CONFIG.categories.find(c => c.id === pending.categoryId);
                            return categoryConfig ? g.channels.cache.has(categoryConfig.id) : false;
                        });
                        
                        if (!guild) {
                            console.warn(`⚠️ Guild not found for restored pending creation`);
                            return;
                        }
                        
                        const member = await guild.members.fetch(userId).catch(() => null);
                        if (!member) {
                            console.warn(`⚠️ Member ${userId} not found for restored creation`);
                            return;
                        }
                        
                        const generatorChannel = guild.channels.cache.get(pending.generatorId);
                        if (!generatorChannel) {
                            console.warn(`⚠️ Generator channel not found for restored creation`);
                            return;
                        }
                        
                        // Check if user is still in generator
                        if (member.voice.channel?.id === generatorChannel.id) {
                            console.log(`✅ User still in generator, creating voice automatically...`);
                            const category = guild.channels.cache.get(pending.categoryId);
                            if (category) {
                                await createVoiceChannel(member, category, generatorChannel);
                            }
                        } else {
                            console.log(`⚠️ User not in generator anymore, skipping auto-create`);
                        }
                        
                        delete voiceData.pendingCreations[userId];
                        
                    } catch (error) {
                        console.error(`❌ Error in restored pending creation: ${error.message}`);
                        delete voiceData.pendingCreations[userId];
                    }
                }, remainingTime);
                
                voiceData.pendingCreations[userId].timeoutId = timeoutId;
                restoredCount++;
            } else {
                delete voiceData.pendingCreations[userId];
            }
        }
    }
    
    console.log(`✅ Restored ${restoredCount} pending voice creations`);
    
    for (const guild of client.guilds.cache.values()) {
        console.log(`\n🏰 Processing guild: ${guild.name} (${guild.id})`);
        await sendOrSyncPanels(guild);
    }
    
    console.log('\n' + '='.repeat(50));
    console.log('✅ BOT SIAP DIGUNAKAN!');
    console.log('='.repeat(50) + '\n');

     // Initialize Concurrent Voice Manager
    console.log('\n🔧 Initializing Concurrent Voice Manager...');
    await initializeConcurrentVoiceManager();
    console.log('   - Max Concurrent: 3 channels');
    console.log('   - Queue Size: 50 users');
    console.log('   - User Rate Limit: 2 seconds\n');
});

// ==========================================
// EVENT: VOICE STATE UPDATE
// ==========================================
const handleVoiceStateUpdate = throttle(async (oldState, newState) => {
    try {
        const member = newState.member;
        const guild = newState.guild;
        
        // ═══════════════════════════════════════════════════════════
        // User join voice channel
        // ═══════════════════════════════════════════════════════════
 if (!oldState.channel && newState.channel) {
            const generatorConfig = CONFIG.categories.find(c => c.generator === newState.channel.id);
            
if (generatorConfig) {
    console.log(`\n👤 ${member.user.tag} joined generator: ${newState.channel.name}`);
    
    // ==========================================
    // GUNAKAN CONCURRENT MANAGER
    // ==========================================
    if (concurrentVoiceManager) {
        try {
            await handleConcurrentVoiceJoin(oldState, newState);
            return; // Stop di sini, concurrent manager yang handle
        } catch (error) {
            console.error(`❌ Concurrent manager error: ${error.message}`);
            
            // Check specific error types
            if (error.message.includes('QUEUE_FULL')) {
                // Queue penuh, user tetap di generator
                console.log(`⚠️ Queue full for ${member.user.tag}, user stays in generator`);
                try {
                    await member.send('⏳ Voice creation queue sedang penuh! Mohon tunggu sebentar dan coba lagi.').catch(() => {});
                } catch (e) {
                    console.log('Cannot send DM to user');
                }
                return;
            }
            
            if (error.message.includes('ALREADY_PROCESSING')) {
                // Sudah dalam proses, skip
                console.log(`⚙️ ${member.user.tag} already being processed`);
                return;
            }
            
            if (error.message.includes('User already has a voice channel')) {
                // User sudah punya channel, pindahkan ke sana
                console.log(`🔄 ${member.user.tag} already has channel, moving...`);
                const existingChannelId = Object.keys(voiceData.owners).find(
                    channelId => voiceData.owners[channelId] === member.id
                );
                if (existingChannelId) {
                    const existingChannel = guild.channels.cache.get(existingChannelId);
                    if (existingChannel) {
                        try {
                            await member.voice.setChannel(existingChannel);
                            return;
                        } catch (e) {
                            console.error('Cannot move user to existing channel:', e.message);
                        }
                    }
                }
                return;
            }
            
            // Untuk error lainnya, fallback ke method lama
            console.error(`⚠️ Fallback to old method for ${member.user.tag}`);
        }
    }
    // ==========================================

    // Fallback jika concurrent manager tidak ada atau error
    const category = guild.channels.cache.get(generatorConfig.id);
                
                if (!category) {
                    console.error(`❌ Category tidak ditemukan: ${generatorConfig.id}`);
                    return;
                }
                
                await createVoiceChannel(member, category, newState.channel);
            } else {
                const ownerId = voiceData.owners[newState.channel.id];
                if (ownerId) {
                    addToJoinOrder(newState.channel.id, member.id);
                    
                    // ═══════════════════════════════════════════════════════════
                    // TAMBAHKAN KODE INI - Give permission to see open chat
                    // ═══════════════════════════════════════════════════════════
                    try {
                        await newState.channel.permissionOverwrites.edit(member.id, {
                            SendMessages: true,
                        });
                        console.log(`✅ ${member.user.tag} can now see open chat in ${newState.channel.name}`);
                    } catch (e) {
                        console.error(`❌ Error giving open chat permission to ${member.user.tag}:`, e.message);
                    }
                    // ═══════════════════════════════════════════════════════════
                }
            }
        }
        
        // User pindah voice channel
        if (oldState.channel && newState.channel && oldState.channel.id !== newState.channel.id) {
            // ═══════════════════════════════════════════════════════════
            // Check if OLD channel is a generator
            // ═══════════════════════════════════════════════════════════
            const oldGeneratorConfig = CONFIG.categories.find(c => c.generator === oldState.channel.id);
            
            if (oldGeneratorConfig) {
                // User pindah DARI generator
                console.log(`\n👤 ${member.user.tag} left generator: ${oldState.channel.name}`);
                
                // Cancel pending creation if exists
                if (voiceData.pendingCreations[member.id]) {
                    const pending = voiceData.pendingCreations[member.id];
                    if (oldState.channel.id === pending.generatorId) {
                        clearTimeout(pending.timeoutId);
                        delete voiceData.pendingCreations[member.id];
                        console.log(`🚫 Cancelled pending creation for ${member.user.tag} (left generator)`);
                        
                        // Send notification to old generator
                        try {
                            if (oldState.channel.isTextBased()) {
                                const cancelEmbed = new EmbedBuilder()
                                    .setColor('#FF9900')
                                    .setDescription(`⚠️ ${member} Pending voice creation cancelled (pindah channel)`)
                                    .setTimestamp();
                                
                                const cancelMsg = await oldState.channel.send({ embeds: [cancelEmbed] });
                                
                                setTimeout(async () => {
                                    try {
                                        await cancelMsg.delete();
                                    } catch (e) {
                                        console.log('⚠️ Tidak bisa menghapus cancel message');
                                    }
                                }, 5000);
                            }
                        } catch (e) {
                            console.error('❌ Error sending cancel notification:', e.message);
                        }
                    }
                }
            } else {
                // User pindah DARI voice channel biasa (bukan generator)
                const oldOwnerId = voiceData.owners[oldState.channel.id];
                if (oldOwnerId) {
                    removeFromJoinOrder(oldState.channel.id, member.id);
                    
                    // Remove permission from old channel
                    try {
                        const hiddenUsers = voiceData.hiddenUsers[oldState.channel.id] || [];
                        if (!hiddenUsers.includes(member.id)) {
                            await oldState.channel.permissionOverwrites.delete(member.id);
                            console.log(`✅ ${member.user.tag} can no longer see open chat in ${oldState.channel.name}`);
                        }
                    } catch (e) {
                        console.error(`❌ Error removing open chat permission from ${member.user.tag}:`, e.message);
                    }
                    
                    if (oldOwnerId === member.id) {
                        voiceData.ownerLeftTime[oldState.channel.id] = Date.now();
                        saveData();
                    }
                    
                    const remainingMembers = oldState.channel.members.filter(m => !m.user.bot);
                    if (remainingMembers.size === 0) {
                        await deleteVoiceChannel(oldState.channel);
                    }
                }
            }
            
            // ═══════════════════════════════════════════════════════════
            // Check if NEW channel is a generator
            // ═══════════════════════════════════════════════════════════
            const newGeneratorConfig = CONFIG.categories.find(c => c.generator === newState.channel.id);
            
            if (newGeneratorConfig) {
                // User pindah KE generator channel
                console.log(`\n👤 ${member.user.tag} moved to generator: ${newState.channel.name}`);
                const category = guild.channels.cache.get(newGeneratorConfig.id);
                
                if (!category) {
                    console.error(`❌ Category tidak ditemukan: ${newGeneratorConfig.id}`);
                    return;
                }
                
                try {
                    const result = await createVoiceChannel(member, category, newState.channel);
                    if (!result) {
                        console.warn(`⚠️ Voice creation returned null for ${member.user.tag}`);
                    }
                } catch (error) {
                    console.error(`❌ Failed to create voice for ${member.user.tag}:`, error.message);
                    // Notify user
                    try {
                        await member.send(`❌ Gagal membuat voice channel: ${error.message}`).catch(() => {});
                    } catch (e) {
                        console.log('⚠️ Cannot send DM to user');
                    }
                }
            } else {
                // User pindah ke voice channel biasa (bukan generator)
                const newOwnerId = voiceData.owners[newState.channel.id];
                if (newOwnerId) {
                    addToJoinOrder(newState.channel.id, member.id);
                    
                    // Give permission to new channel
                    try {
                        await newState.channel.permissionOverwrites.edit(member.id, {
                            ViewChannel: true,
                            SendMessages: true,
                            ReadMessageHistory: true
                        });
                        console.log(`✅ ${member.user.tag} can now see open chat in ${newState.channel.name}`);
                    } catch (e) {
                        console.error(`❌ Error giving open chat permission to ${member.user.tag}:`, e.message);
                    }
                }
            }
        }
        
        // ═══════════════════════════════════════════════════════════
        // User leave voice
        // ═══════════════════════════════════════════════════════════
        if (oldState.channel && !newState.channel) {
            const ownerId = voiceData.owners[oldState.channel.id];
            
            if (ownerId) {
                console.log(`\n👤 ${member.user.tag} left voice: ${oldState.channel.name}`);
                removeFromJoinOrder(oldState.channel.id, member.id);
                
                // ═══════════════════════════════════════════════════════════
                // TAMBAHKAN KODE INI - Remove permission when leave
                // ═══════════════════════════════════════════════════════════
                try {
                    // Hapus permission (kecuali jika user di-hide)
                    const hiddenUsers = voiceData.hiddenUsers[oldState.channel.id] || [];
                    if (!hiddenUsers.includes(member.id)) {
                        await oldState.channel.permissionOverwrites.delete(member.id);
                        console.log(`✅ ${member.user.tag} can no longer see open chat in ${oldState.channel.name}`);
                    }
                } catch (e) {
                    console.error(`❌ Error removing open chat permission from ${member.user.tag}:`, e.message);
                }
                // ═══════════════════════════════════════════════════════════
                
                if (ownerId === member.id) {
                    voiceData.ownerLeftTime[oldState.channel.id] = Date.now();
                    saveData();
                    console.log(`⏰ Owner left, timestamp set for 30 min claim`);
                }
                
                try {
                    const remainingMembers = oldState.channel.members.filter(m => !m.user.bot);
                    
                    if (remainingMembers.size === 0) {
                        await deleteVoiceChannel(oldState.channel);
                    }
                } catch (e) {
                    console.error('❌ Error in leave handler:', e.message);
                }
            }
            
            // Cancel pending creation if user leaves generator
            if (voiceData.pendingCreations[member.id]) {
                const pending = voiceData.pendingCreations[member.id];
                if (oldState.channel.id === pending.generatorId) {
                    clearTimeout(pending.timeoutId);
                    delete voiceData.pendingCreations[member.id];
                    console.log(`🚫 Cancelled pending creation for ${member.user.tag} (left generator)`);
                }
            }
        }
        
    } catch (e) {
        console.error('❌ Voice state update error:', e.message);
        console.error('Stack:', e.stack);
    }
}, 500); // Max 1 call per 500ms per event

client.on('voiceStateUpdate', handleVoiceStateUpdate);

// ==========================================
// EVENT: INTERACTION CREATE
// ==========================================
client.on('interactionCreate', async (interaction) => {
    try {
        if (interaction.isButton()) {
            await handleButtonInteraction(interaction);
        } else if (interaction.isStringSelectMenu()) {
            await handleSelectMenu(interaction);
        } else if (interaction.isModalSubmit()) {
            await handleModalSubmit(interaction);
        }
    } catch (e) {
        console.error('❌ Interaction create error:', e.message);
        console.error('Stack:', e.stack);
    }
});

// ==========================================
// EVENT: MESSAGE CREATE (Commands)
// ==========================================
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    
    try {
        const member = message.member;
        const args = message.content.split(' ');
        const command = args[0].toLowerCase();
        
    if (command === '!voiceinfo') {
        // Check if user mentioned someone
        const mentionedUser = message.mentions.users.first();
        
        if (!mentionedUser) {
            return await message.reply('❌ Tag user yang ingin dicari!\n**Contoh:** `!voiceinfo @username`');
        }
        
        try {
            // Fetch member from guild
            const targetMember = await message.guild.members.fetch(mentionedUser.id).catch(() => null);
            
            if (!targetMember) {
                return await message.reply('❌ User tidak ditemukan di server ini!');
            }
            
            // Check if user is in voice channel
            if (!targetMember.voice.channel) {
                return await message.reply(`❌ ${mentionedUser} sedang tidak berada di voice channel!`);
            }
            
            const voiceChannel = targetMember.voice.channel;
            const ownerId = voiceData.owners[voiceChannel.id];
            const owner = ownerId ? await message.guild.members.fetch(ownerId).catch(() => null) : null;
            
            // Create voice channel link
            const voiceLink = `https://discord.com/channels/${message.guild.id}/${voiceChannel.id}`;
            
            // Get member count (excluding bots)
            const humanMembers = voiceChannel.members.filter(m => !m.user.bot);
            const memberList = humanMembers.map(m => `• ${m.displayName}`).slice(0, 10).join('\n');
            const moreMembers = humanMembers.size > 10 ? `\n*...dan ${humanMembers.size - 10} lainnya*` : '';
            
            const embed = new EmbedBuilder()
                .setColor('#9b59b6')
                .setTitle('🔊 Voice Channel Info')
                .setDescription(`**${mentionedUser}** sedang berada di:`)
                .addFields(
                    { name: '👇**KLIK DISINI UNTUK JOIN VOICE**👇', value: `[${voiceChannel.name}](${voiceLink})`, inline: false },
                    { name: '👑 Owner', value: owner ? owner.toString() : 'Unknown', inline: true },
                    { name: '👥 Members', value: `${humanMembers.size} orang`, inline: true },
                    { name: '🔢 Limit', value: voiceChannel.userLimit === 0 ? 'Unlimited' : voiceChannel.userLimit.toString(), inline: true },
                    { name: '📋 Members List', value: memberList + moreMembers || 'Tidak ada member', inline: false }
                )
                .setFooter({ text: 'JUSTRU KENAL' })
                .setTimestamp();
            
            await message.reply({ embeds: [embed] });
            
        } catch (e) {
            console.error('❌ Error voiceinfo command:', e.message);
            await message.reply('❌ Terjadi error saat mencari user!');
        }
        return;
    }
        
        if (!isAdmin(member)) return;
        
        if (command === '!log') {
            // Check apakah user adalah admin
            if (!isAdmin(member)) {
                return message.reply('❌ Command ini hanya untuk admin!');
            }
            
            const action = args[1]?.toLowerCase();
            
            if (action === 'on') {
                CONFIG.logEnabled = true;
                await message.reply('✅ Logging diaktifkan!');
            } else if (action === 'off') {
                CONFIG.logEnabled = false;
                await message.reply('✅ Logging dinonaktifkan!');
            } else {
                await message.reply('📝 Status logging: ' + (CONFIG.logEnabled ? 'ON' : 'OFF'));
            }
        }
        
        if (command === '!panel') {
            // Check apakah user adalah admin
            if (!isAdmin(member)) {
                return message.reply('❌ Command ini hanya untuk admin!');
            }

            const action = args[1]?.toLowerCase();
            
            if (action === 'resend' || action === 'sync') {
                await sendOrSyncPanels(message.guild);
                await message.reply('✅ Panel telah di' + (action === 'resend' ? 'kirim ulang' : 'sinkronisasi') + '!');
            } else {
                await message.reply('📋 Gunakan: `!panel resend` atau `!panel sync`');
            }
        }
        
        if (command === '!debug') {
            // Check apakah user adalah admin
            if (!isAdmin(member)) {
                return message.reply('❌ Command ini hanya untuk admin!');
            }
            
            const embed = new EmbedBuilder()
                .setColor('#9b59b6')
                .setTitle('🔍 Debug Information')
                .addFields(
                    { name: 'Bot Status', value: '✅ Online', inline: true },
                    { name: 'Guilds', value: client.guilds.cache.size.toString(), inline: true },
                    { name: 'Logging', value: CONFIG.logEnabled ? 'ON' : 'OFF', inline: true },
                    { name: 'Voice Owners', value: Object.keys(voiceData.owners).length.toString(), inline: true },
                    { name: 'Join Orders', value: Object.keys(voiceData.joinOrder).length.toString(), inline: true },
                    { name: 'Owner Left Timestamps', value: Object.keys(voiceData.ownerLeftTime).length.toString(), inline: true }
                )
                .setTimestamp();
            
            await message.reply({ embeds: [embed] });
        }

        // Voice stats command (ADMIN ONLY)
        if (command === '!voice-stats' || command === '!vstats') {
            // Check apakah user adalah admin
            if (!isAdmin(member)) {
                return message.reply('❌ Command ini hanya untuk admin!');
            }
            if (!concurrentVoiceManager) {
                return message.reply('❌ Concurrent manager belum diinisialisasi');
            }
            
            const stats = concurrentVoiceManager.queue.getStats();
            const managerStats = concurrentVoiceManager.stats;
            
            const embed = new EmbedBuilder()
                .setTitle('📊 Voice Queue Statistics')
                .setColor('#00FF00')
                .addFields(
                    { name: 'Queue Length', value: stats.queueLength.toString(), inline: true },
                    { name: 'Processing', value: stats.processingCount.toString(), inline: true },
                    { name: 'Locked Channels', value: stats.lockedChannels.toString(), inline: true },
                    { name: 'Total Processed', value: stats.totalProcessed.toString(), inline: true },
                    { name: 'Total Rejected', value: stats.totalRejected.toString(), inline: true },
                    { name: 'Peak Concurrent', value: stats.concurrentPeak.toString(), inline: true },
                    { name: 'Avg Processing', value: `${Math.round(stats.avgProcessingTime)}ms`, inline: true },
                    { name: 'Total Joins', value: managerStats.totalJoins.toString(), inline: true },
                    { name: 'Max Simultaneous', value: managerStats.maxSimultaneous.toString(), inline: true }
                )
                .setTimestamp();
            
            return message.reply({ embeds: [embed] });
        }
    } catch (e) {
        console.error('❌ Message create error:', e.message);
    }
});

// ==========================================
// ERROR HANDLERS
// ==========================================
client.on('error', error => {
    console.error('\n❌ Discord Client Error:', error.message);
});

client.on('warn', warning => {
    console.warn('\n⚠️ Discord Client Warning:', warning);
});

process.on('unhandledRejection', error => {
    console.error('\n❌ Unhandled Promise Rejection:', error.message);
});

process.on('uncaughtException', error => {
    console.error('\n❌ Uncaught Exception:', error.message);
    console.error('\n⚠️ Bot mungkin perlu di-restart!');
});

// ==========================================
// MEMORY MONITORING & AUTO CLEANUP
// ==========================================
setInterval(() => {
    const heapStats = v8.getHeapStatistics();
    const memUsage = process.memoryUsage();
    
    const heapUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024);
    const heapTotalMB = Math.round(memUsage.heapTotal / 1024 / 1024);
    const heapLimitMB = Math.round(heapStats.heap_size_limit / 1024 / 1024);
    const rssMB = Math.round(memUsage.rss / 1024 / 1024);
    const externalMB = Math.round(memUsage.external / 1024 / 1024);
    
    const heapUsagePercent = (heapUsedMB / heapLimitMB * 100).toFixed(1);
    
    console.log(`\n📊 Memory Usage: Heap ${heapUsedMB}/${heapLimitMB}MB (${heapUsagePercent}%) | RSS ${rssMB}MB | External ${externalMB}MB`);
    
    // Clean expired cache items (sebelum check critical)
    const expiredMember = memberCache.cleanExpired();
    const expiredChannel = channelCache.cleanExpired();
    
    // Log cache stats
    console.log(`🗂️  Cache Stats: Members ${memberCache.size()} | Channels ${channelCache.size()}`);
    
    // Level 1: Warning (70%)
    if (heapUsagePercent > 70 && heapUsagePercent <= 80) {
        console.warn('🟡 WARNING: Memory usage above 70%');
        
        // Clear caches
        memberCache.clear();
        channelCache.clear();
        
        console.log('🧹 Caches cleared');
    }
    
    // Level 2: Critical (80%)
    if (heapUsagePercent > 80 && heapUsagePercent <= 90) {
        console.error('🟠 CRITICAL: Memory usage above 80%!');
        
        // Clear all caches
        memberCache.clear();
        channelCache.clear();
        
        // Clean expired cooldowns
        const now = Date.now();
        let cleaned = 0;
        
        Object.keys(voiceData.buttonCooldowns).forEach(key => {
            if (now - voiceData.buttonCooldowns[key] > 300000) {
                delete voiceData.buttonCooldowns[key];
                cleaned++;
            }
        });
        
        Object.keys(voiceData.hideUnhideCooldowns).forEach(key => {
            if (now - voiceData.hideUnhideCooldowns[key] > 60000) {
                delete voiceData.hideUnhideCooldowns[key];
                cleaned++;
            }
        });
        
        Object.keys(voiceData.cooldowns).forEach(key => {
            if (now - voiceData.cooldowns[key] > 120000) {
                delete voiceData.cooldowns[key];
                cleaned++;
            }
        });
        
        console.log(`🧹 Cleaned ${cleaned} expired cooldowns`);
        
        // Force GC if available
        if (global.gc) {
            global.gc();
            console.log('♻️  Forced garbage collection');
        }
    }
    
    // Level 3: Emergency (90%)
    if (heapUsagePercent > 90) {
        console.error('🔴 EMERGENCY: Memory usage above 90%!');
        console.error('⚠️  Bot might crash soon, aggressive cleanup initiated!');
        
        // Emergency cleanup - clear EVERYTHING
        memberCache.clear();
        channelCache.clear();
        
        // Clear ALL cooldowns (aggressive)
        voiceData.buttonCooldowns = {};
        voiceData.hideUnhideCooldowns = {};
        voiceData.cooldowns = {};
        voiceData.pendingCreations = {};
        
        // Cancel all pending timeouts
        Object.values(voiceData.pendingCreations).forEach(pending => {
            if (pending.timeoutId) clearTimeout(pending.timeoutId);
        });
        
        // Force save (exclude pendingCreations)
        try {
            const dataToSave = {
                owners: voiceData.owners,
                panelMessages: voiceData.panelMessages,
                cooldowns: voiceData.cooldowns,
                hiddenUsers: voiceData.hiddenUsers,
                joinOrder: voiceData.joinOrder,
                ownerLeftTime: voiceData.ownerLeftTime,
                hideUnhideCooldowns: voiceData.hideUnhideCooldowns,
                buttonCooldowns: voiceData.buttonCooldowns
            };
            
            const fs = require('fs');
            fs.writeFileSync(DATA_FILE, JSON.stringify(dataToSave, null, 2));
            console.log('💾 Emergency data save completed');
        } catch (e) {
            console.error('❌ Emergency save failed:', e.message);
        }
        
        // Force GC multiple times
        if (global.gc) {
            for (let i = 0; i < 3; i++) {
                global.gc();
            }
            console.log('♻️  Emergency GC triggered (3x)');
        }
        
        // Re-check after cleanup
        const newMemUsage = process.memoryUsage();
        const newHeapUsedMB = Math.round(newMemUsage.heapUsed / 1024 / 1024);
        const newHeapPercent = (newHeapUsedMB / heapLimitMB * 100).toFixed(1);
        
        console.log(`📊 After cleanup: ${newHeapUsedMB}/${heapLimitMB}MB (${newHeapPercent}%)`);
        
        if (newHeapPercent > 85) {
            console.error('🚨 Memory still critical after cleanup!');
            console.error('💡 Consider restarting the bot or increasing heap size');
        }
    }
    
}, 3600000); // Every 1 hour
// Additional cleanup every 1 hour
setInterval(() => {
    console.log('\n🧹 Running scheduled cleanup...');
    
    const now = Date.now();
    let totalCleaned = 0;
    
    // Clean expired cooldowns
    ['buttonCooldowns', 'hideUnhideCooldowns', 'cooldowns'].forEach(cooldownType => {
        const maxAge = cooldownType === 'buttonCooldowns' ? 300000 : 
                       cooldownType === 'hideUnhideCooldowns' ? 60000 : 120000;
        
        const before = Object.keys(voiceData[cooldownType]).length;
        
        Object.keys(voiceData[cooldownType]).forEach(userId => {
            if (now - voiceData[cooldownType][userId] > maxAge) {
                delete voiceData[cooldownType][userId];
                totalCleaned++;
            }
        });
        
        const after = Object.keys(voiceData[cooldownType]).length;
        if (before !== after) {
            console.log(`  🗑️  ${cooldownType}: ${before} → ${after} (-${before - after})`);
        }
    });
    
    // Clean expired cache items
    const expiredMember = memberCache.cleanExpired();
    const expiredChannel = channelCache.cleanExpired();
    totalCleaned += expiredMember + expiredChannel;
    
    console.log(`✅ Scheduled cleanup complete: ${totalCleaned} items removed\n`);
    
}, 3600000); // Every 1 hour

async function gracefulShutdown(signal) {
    console.log(`\n📥 Received ${signal}, shutting down gracefully...`);
    
    try {
        // Stop Keep-Alive
        console.log('🛑 Stopping keep-alive server...');
        await stopKeepAlive();
        
        // Save data one last time (exclude pendingCreations)
        console.log('💾 Saving final data...');
        const dataToSave = {
            owners: voiceData.owners,
            panelMessages: voiceData.panelMessages,
            cooldowns: voiceData.cooldowns,
            hiddenUsers: voiceData.hiddenUsers,
            joinOrder: voiceData.joinOrder,
            ownerLeftTime: voiceData.ownerLeftTime,
            hideUnhideCooldowns: voiceData.hideUnhideCooldowns,
            buttonCooldowns: voiceData.buttonCooldowns
        };
        fs.writeFileSync(DATA_FILE, JSON.stringify(dataToSave, null, 2));
        
        // Clear pending timeouts
        console.log('🧹 Clearing pending operations...');
        Object.values(voiceData.pendingCreations).forEach(pending => {
            if (pending.timeoutId) clearTimeout(pending.timeoutId);
        });
        
        // Destroy client
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

// ==========================================
// LOGIN
// ==========================================
console.log('\n🔐 Mencoba login ke Discord...\n');

client.login(process.env.DISCORD_TOKEN)
    .then(() => {
        console.log('✅ Login berhasil!');
    })
    .catch(e => {
        console.error('\n' + '='.repeat(50));
        console.error('❌ GAGAL LOGIN KE DISCORD!');
        console.error('='.repeat(50));
        console.error('Error:', e.message);
        process.exit(1);
    });
