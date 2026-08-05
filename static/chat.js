// ==================== SOCKET & STATE ====================
const socket = io({
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    reconnectionAttempts: 5,
    timeout: 20000,
    // transposts: ['websocket', 'polling'], // Default is fine now
    upgrade: true,
    rememberUpgrade: true
});
let username = null;
let currentRecipient = null;
const sharedKeys = {};
let typingTimeout = null;
let currentMessageId = null;
const userStatuses = {};
let allUsers = [];
let allGroups = [];
let replyToMessage = null;

// Cache messages by id for quick lookup when rendering reply previews
window.messageIndex = window.messageIndex || {};

// Enhanced typing indicators - track who's typing in each conversation
const typingUsers = {}; // { conversation_id: Set(['user1', 'user2']) }

// Voice recording
let mediaRecorder = null;
let audioChunks = [];
let recordingStartTime = null;
let recordingTimer = null;

// WebRTC for calls
let peerConnection = null;
let localStream = null;
let currentCall = null;
const iceServers = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ]
};
// Buffer incoming ICE candidates until remoteDescription is set
let pendingIceCandidates = [];

// ==================== HELPER FUNCTIONS ====================
const byId = id => document.getElementById(id);

function getInitials(name) {
    return name ? name.substring(0, 2).toUpperCase() : '??';
}

// Insert emoji at cursor position in the message input
function insertEmoji() {
    // Fallback insertion if EmojiButton not available
    const emoji = '😄';
    const input = byId('messageInput');
    if (!input) return;
    const start = input.selectionStart || input.value.length;
    const end = input.selectionEnd || start;
    input.value = input.value.substring(0, start) + emoji + input.value.substring(end);
    input.focus();
    const pos = start + emoji.length;
    input.selectionStart = input.selectionEnd = pos;
}

// Setup UI interactions for new messages indicator and FAB
document.addEventListener('DOMContentLoaded', () => {
    const messagesEl = byId('messages');
    const indicator = byId('newMessagesIndicator');
    const fab = byId('newChatFab');

    if (messagesEl) {
        messagesEl.addEventListener('scroll', () => {
            if (isMessagesAtBottom()) {
                hideNewMessagesIndicator();
            }
        });
    }

    if (indicator) {
        indicator.addEventListener('click', () => {
            const el = byId('messages');
            if (el) {
                el.scrollTop = el.scrollHeight;
            }
            hideNewMessagesIndicator();
        });
    }

    if (fab) {
        fab.addEventListener('click', () => {
            const name = prompt('Start a chat with (username):');
            if (name) {
                // If user exists in list, select; else add temporary entry
                const existing = Array.from(document.querySelectorAll('#userList li')).find(li => li.dataset.username === name);
                if (existing) {
                    existing.click();
                } else {
                    // Create a temporary entry and select it
                    const li = document.createElement('li');
                    li.dataset.username = name;
                    const avatar = document.createElement('div');
                    avatar.className = 'user-avatar';
                    avatar.innerHTML = getInitials(name);
                    const info = document.createElement('div');
                    info.className = 'user-info';
                    const nm = document.createElement('div'); nm.className = 'user-name'; nm.textContent = name;
                    const lastRow = document.createElement('div'); lastRow.style.display = 'flex'; lastRow.style.alignItems = 'center'; lastRow.style.gap = '8px';
                    const lastMsg = document.createElement('div'); lastMsg.className = 'user-last-message'; lastMsg.textContent = 'Tap to start chatting';
                    const meta = document.createElement('div'); meta.className = 'user-last-meta'; meta.textContent = '';
                    lastRow.appendChild(lastMsg); lastRow.appendChild(meta);
                    info.appendChild(nm); info.appendChild(lastRow);
                    li.appendChild(avatar); li.appendChild(info);
                    document.getElementById('userList').prepend(li);
                    li.click();
                }
            }
        });
    }

    // Initialize Emoji picker with a custom lightweight popup (fallback if external lib fails)
    (function initCustomEmojiPicker() {
        const emojiBtn = byId('emojiBtn');
        if (!emojiBtn) return;

        // Keep a single picker element
        let pickerEl = null;
        const EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🎉', '🔥', '👏', '🙏', '😅', '🤔', '😍', '😎', '🤩', '🤝', '🎯', '🙌', '😴', '🫡', '💯', '✨', '🙂', '😊', '😜', '😇', '🤗', '😬', '😳', '🤖', '👋', '🙏', '🥳', '🤝'];

        function createPicker() {
            pickerEl = document.createElement('div');
            pickerEl.className = 'emoji-picker-panel';
            pickerEl.style.cssText = 'position: absolute; display: grid; grid-template-columns: repeat(6, 36px); gap: 8px; padding: 12px; background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 12px; box-shadow: var(--shadow-md); z-index: 99999; width: max-content; max-width: 300px;';
            EMOJIS.forEach(emoji => {
                const b = document.createElement('button');
                b.type = 'button';
                b.textContent = emoji;
                b.style.cssText = 'font-size: 20px; background: none; border: none; cursor: pointer; padding: 6px; border-radius: 6px;';
                b.onclick = () => {
                    const input = byId('messageInput');
                    if (!input) return;
                    const start = input.selectionStart || input.value.length;
                    const end = input.selectionEnd || start;
                    input.value = input.value.substring(0, start) + emoji + input.value.substring(end);
                    input.focus();
                    const pos = start + emoji.length;
                    input.selectionStart = input.selectionEnd = pos;
                    hidePicker();
                };
                pickerEl.appendChild(b);
            });
            document.body.appendChild(pickerEl);
            document.addEventListener('click', function closePicker(e) {
                if (!pickerEl) return;
                if (!pickerEl.contains(e.target) && e.target !== emojiBtn) {
                    hidePicker();
                    document.removeEventListener('click', closePicker);
                }
            });
        }

        function showPicker() {
            if (!pickerEl) createPicker();
            const rect = emojiBtn.getBoundingClientRect();
            pickerEl.style.left = (rect.left) + 'px';
            pickerEl.style.top = (rect.top - pickerEl.offsetHeight - 8) + 'px';
            pickerEl.style.display = 'grid';
        }

        function hidePicker() {
            if (!pickerEl) return;
            pickerEl.style.display = 'none';
        }

        emojiBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!pickerEl || pickerEl.style.display === 'none') showPicker(); else hidePicker();
        });
    })();
});

function showNotification(message) {
    const notif = byId('notification');
    byId('notificationText').textContent = message;
    notif.classList.add('show');
    setTimeout(() => notif.classList.remove('show'), 3000);

    if (Notification.permission === 'granted') {
        new Notification('BB84 Chat', { body: message });
    }
}

function requestNotificationPermission() {
    if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission();
    }
}

function formatTime(date) {
    if (!date) return '';
    const d = typeof date === 'string' ? new Date(date) : date;
    if (isNaN(d.getTime())) return '';
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDate(date) {
    const d = new Date(date);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    if (d.toDateString() === today.toDateString()) {
        return 'Today';
    } else if (d.toDateString() === yesterday.toDateString()) {
        return 'Yesterday';
    } else {
        return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    }
}

// ==================== AUTH ====================
function toggleAuth(mode) {
    byId('login-box').style.display = mode === 'login' ? 'block' : 'none';
    byId('register-box').style.display = mode === 'register' ? 'block' : 'none';
    if (byId('reset-box')) byId('reset-box').style.display = mode === 'reset' ? 'block' : 'none';
    byId('login-error').style.display = 'none';
    byId('register-error').style.display = 'none';
}

async function performAuth(endpoint, user, pass, errorEl, extra = {}) {
    if (!user || !pass) {
        errorEl.textContent = 'Please fill in all fields';
        errorEl.style.display = 'block';
        return;
    }

    // Check if socket is connected
    if (!socket.connected) {
        errorEl.textContent = 'Connecting to server...';
        errorEl.style.display = 'block';

        // Wait for connection with timeout
        let connectionTimeout;
        const waitForConnection = new Promise((resolve, reject) => {
            if (socket.connected) {
                resolve();
                return;
            }

            const onConnect = () => {
                socket.off('connect', onConnect);
                socket.off('connect_error', onError);
                clearTimeout(connectionTimeout);
                resolve();
            };

            const onError = (error) => {
                socket.off('connect', onConnect);
                socket.off('connect_error', onError);
                clearTimeout(connectionTimeout);
                reject(error);
            };

            socket.on('connect', onConnect);
            socket.on('connect_error', onError);

            connectionTimeout = setTimeout(() => {
                socket.off('connect', onConnect);
                socket.off('connect_error', onError);
                reject(new Error('Connection timeout'));
            }, 5000);
        });

        try {
            await waitForConnection;
            errorEl.style.display = 'none';
        } catch (error) {
            errorEl.textContent = 'Cannot connect to server. Please check your connection.';
            errorEl.style.display = 'block';
            return;
        }
    }

    try {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: user, password: pass, ...extra })
        });

        if (!response.ok) {
            // Try to get error message from JSON response
            try {
                const errorData = await response.json();
                throw new Error(errorData.error || errorData.message || `Server Error (${response.status})`);
            } catch (e) {
                // If parsing fails or we just threw above
                if (e.message !== `Server Error (${response.status})` && !e.message.includes('JSON')) {
                    throw e; // Rethrow actual server error message
                }
                throw new Error(`Server Error (${response.status})`);
            }
        }

        const data = await response.json();

        if (data.success) {
            startChatSession(user);
            requestNotificationPermission();
        } else {
            // Handle success:false in 200 OK response
            throw new Error(data.error || 'Authentication failed');
        }
    } catch (error) {
        console.error('Auth error:', error);
        if (error.name === 'TypeError' && error.message.includes('fetch')) {
            errorEl.textContent = 'Cannot reach server. Please check your connection.';
        } else {
            // Display the actual error message from server
            errorEl.textContent = error.message;
        }
        errorEl.style.display = 'block';
    }
}

function login() {
    performAuth('/login',
        byId('login-username').value.trim(),
        byId('login-password').value.trim(),
        byId('login-error')
    );
}

function register() {
    performAuth('/register',
        byId('register-username').value.trim(),
        byId('register-password').value.trim(),
        byId('register-error'),
        { email: byId('register-email')?.value.trim() || '' }
    );
}

async function requestPasswordReset() {
    const email = byId('reset-email').value.trim();
    const output = byId('reset-message');
    if (!email) { output.textContent = 'Enter your account email.'; output.style.display = 'block'; return; }
    try {
        const response = await fetch('/request_password_reset', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ email }) });
        const data = await response.json();
        output.textContent = data.message || data.error || 'If the account exists, a reset link has been issued.';
        output.style.display = 'block';
    } catch (_) { output.textContent = 'Unable to request a reset right now.'; output.style.display = 'block'; }
}

function startChatSession(user) {
    username = user;
    byId('auth-screen').style.display = 'none';
    byId('chat-screen').style.display = 'flex';
    socket.emit("register_user", username);
    socket.emit("update_status", { username, status: "online" });
    socket.emit("get_user_groups", { username });
}

function logout() {
    if (!confirm('Are you sure you want to logout?')) return;

    // Update status to offline
    if (username) {
        socket.emit("update_status", { username, status: "offline" });
    }

    // Disconnect socket
    socket.disconnect();

    // Clear session data
    username = null;
    currentRecipient = null;
    allUsers = [];
    allGroups = [];
    replyToMessage = null;

    // Stop any ongoing calls
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }

    // Clear UI
    byId('userList').innerHTML = '';
    byId('messages').innerHTML = '';
    byId('messageInput').value = '';

    // Show auth screen
    byId('chat-screen').style.display = 'none';
    byId('auth-screen').style.display = 'flex';

    // Reconnect socket for next login
    setTimeout(() => {
        socket.connect();
    }, 500);

    showNotification('Logged out successfully');
}

// ==================== USER LIST ====================
function filterUsers() {
    const searchTerm = byId('userSearch').value.toLowerCase();
    const users = Array.from(byId('userList').children);
    users.forEach(li => {
        const userName = li.dataset.username?.toLowerCase() || '';
        li.style.display = userName.includes(searchTerm) ? '' : 'none';
    });
}

function getUserStatusClass(status) {
    const statusMap = {
        'online': 'status-online',
        'away': 'status-away',
        'busy': 'status-busy',
        'offline': 'status-offline'
    };
    return statusMap[status] || 'status-online';
}

function updateUserList(users) {
    allUsers = users.filter(u => u !== username);
    const userList = byId('userList');
    userList.innerHTML = "";
    let recipientIsOnline = false;

    // Add groups first
    allGroups.forEach(group => {
        if (group.name === currentRecipient) recipientIsOnline = true;

        const li = document.createElement("li");
        li.dataset.username = group.name;
        li.dataset.isGroup = "true";

        const avatar = document.createElement("div");
        avatar.className = "user-avatar";
        avatar.style.background = "var(--accent-gradient)";
        avatar.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>`;

        const info = document.createElement("div");
        info.className = "user-info";

        const name = document.createElement("div");
        name.className = "user-name";
        name.textContent = group.name;

        const lastRow = document.createElement('div');
        lastRow.style.display = 'flex';
        lastRow.style.alignItems = 'center';
        lastRow.style.gap = '8px';

        const lastMsg = document.createElement("div");
        lastMsg.className = "user-last-message";
        lastMsg.textContent = `${group.member_count} members`;

        const meta = document.createElement('div');
        meta.className = 'user-last-meta';
        meta.textContent = '';

        lastRow.appendChild(lastMsg);
        lastRow.appendChild(meta);

        // Populate last message preview and timestamp if available
        const lm = window.lastMessages?.[group.name];
        if (lm) {
            lastMsg.textContent = lm.text || `${group.member_count} members`;
            meta.textContent = lm.timestamp ? formatTime(lm.timestamp) : '';
        }

        info.appendChild(name);
        info.appendChild(lastRow);

        li.appendChild(avatar);
        li.appendChild(info);

        if (group.name === currentRecipient) li.classList.add('active');

        li.onclick = () => selectGroup(group.name, li);
        userList.appendChild(li);
    });

    // Add users
    allUsers.forEach(u => {
        if (u === currentRecipient) recipientIsOnline = true;

        const li = document.createElement("li");
        li.dataset.username = u;

        const avatar = document.createElement("div");
        avatar.className = "user-avatar";

        // Check if user has avatar
        const userAvatarUrl = window.userData?.[u]?.avatar_url;
        if (userAvatarUrl) {
            avatar.style.backgroundImage = `url(${userAvatarUrl})`;
            avatar.style.backgroundSize = 'cover';
            avatar.style.backgroundPosition = 'center';
        } else {
            avatar.innerHTML = getInitials(u);
        }

        const badge = document.createElement("div");
        badge.className = "user-status-badge " + getUserStatusClass(userStatuses[u] || 'online');
        avatar.appendChild(badge);

        const info = document.createElement("div");
        info.className = "user-info";

        const name = document.createElement("div");
        name.className = "user-name";
        name.textContent = u;

        const lastRow = document.createElement('div');
        lastRow.style.display = 'flex';
        lastRow.style.alignItems = 'center';
        lastRow.style.gap = '8px';

        const lastMsg = document.createElement("div");
        lastMsg.className = "user-last-message";
        lastMsg.textContent = "Tap to start chatting";

        const meta = document.createElement('div');
        meta.className = 'user-last-meta';
        meta.textContent = '';

        lastRow.appendChild(lastMsg);
        lastRow.appendChild(meta);

        // Populate last message preview and timestamp if available
        const lm = window.lastMessages?.[u];
        if (lm) {
            lastMsg.textContent = lm.text || 'Tap to start chatting';
            meta.textContent = lm.timestamp ? formatTime(lm.timestamp) : '';
        }

        info.appendChild(name);
        info.appendChild(lastRow);

        // unread badge
        const unread = document.createElement('span');
        unread.className = 'unread-badge';
        unread.style.display = 'none';
        unread.dataset.username = u;
        info.appendChild(unread);

        li.appendChild(avatar);
        li.appendChild(info);

        if (u === currentRecipient) li.classList.add('active');

        li.onclick = () => { selectUser(u, li); clearUnread(u); };
        userList.appendChild(li);
    });

    if (!recipientIsOnline && currentRecipient) {
        currentRecipient = null;
        byId('chat-window').style.display = "none";
    }
}

// ==================== MOBILE NAVIGATION ====================
function showSidebar() {
    byId('chat-screen').classList.remove('chat-active');
}

function hideSidebarOnMobile() {
    // Only hide on mobile devices
    if (window.innerWidth <= 768) {
        byId('chat-screen').classList.add('chat-active');
    }
}

function selectUser(user, element) {
    if (currentRecipient === user) return;

    currentRecipient = user;
    document.querySelectorAll('#userList li').forEach(item => item.classList.remove('active'));
    element.classList.add('active');

    byId('chat-partner-name').textContent = currentRecipient;
    const chatAvatar = byId('chatAvatar');
    const userAvatarUrl = window.userData?.[currentRecipient]?.avatar_url;
    if (userAvatarUrl) {
        chatAvatar.style.backgroundImage = `url(${userAvatarUrl})`;
        chatAvatar.style.backgroundSize = 'cover';
        chatAvatar.style.backgroundPosition = 'center';
        chatAvatar.innerHTML = '';
    } else {
        chatAvatar.style.backgroundImage = '';
        chatAvatar.innerHTML = getInitials(currentRecipient);
    }
    byId('messages').innerHTML = "";
    byId('chat-window').style.display = "flex";
    hideSidebarOnMobile();

    socket.emit("get_history", { user1: username, user2: currentRecipient });
    socket.emit("get_user_status", { username: user });
}

function selectGroup(groupName, element) {
    if (currentRecipient === groupName) return;

    currentRecipient = groupName;
    document.querySelectorAll('#userList li').forEach(item => item.classList.remove('active'));
    element.classList.add('active');

    byId('chat-partner-name').textContent = currentRecipient;
    byId('chatAvatar').innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>`;
    byId('messages').innerHTML = "";
    byId('chat-window').style.display = "flex";
    hideSidebarOnMobile();

    socket.emit("get_group_history", { group_name: groupName, username: username });

    // Add group settings button
    addGroupSettingsButtonToHeader();
}

// ==================== MESSAGES ====================
let lastMessageDate = null;
let lastMessageSender = null;

function appendMessage(sender, message, data = {}) {
    const msgContainer = byId('messages');
    const welcome = byId('welcome');
    if (welcome) welcome.remove();

    // Track whether user is at the bottom before adding
    const wasAtBottom = isMessagesAtBottom();

    // Add date separator if needed
    const msgDate = data.timestamp ? new Date(data.timestamp) : new Date();
    const dateStr = formatDate(msgDate);

    if (dateStr !== lastMessageDate) {
        const separator = document.createElement("div");
        separator.className = "date-separator";
        separator.textContent = dateStr;
        msgContainer.appendChild(separator);
        lastMessageDate = dateStr;
        lastMessageSender = null;
    }

    // Check if this is part of a cluster
    const isCluster = lastMessageSender === sender;

    const msgDiv = document.createElement("div");
    msgDiv.classList.add("message");
    msgDiv.classList.add(sender === username ? "sent" : "received");
    msgDiv.dataset.messageId = data.id || Date.now();
    const msgId = msgDiv.dataset.messageId;

    if (!isCluster) {
        msgDiv.classList.add("first");
    }
    msgDiv.classList.add("last");

    // Update previous message to not be last if it's in a cluster
    if (isCluster) {
        const messages = msgContainer.querySelectorAll('.message');
        const prevMsg = messages[messages.length - 1];
        if (prevMsg) {
            prevMsg.classList.remove('last');
        }
    }

    // Avatar (show for received messages only, and not for clusters)
    if (!isCluster && sender !== username) {
        const avatar = document.createElement("div");
        avatar.className = "message-avatar";
        const avatarUrl = window.userData?.[sender]?.avatar_url;
        if (avatarUrl) {
            avatar.style.backgroundImage = `url(${avatarUrl})`;
            avatar.style.backgroundSize = 'cover';
            avatar.style.backgroundPosition = 'center';
            avatar.textContent = '';
        } else {
            avatar.textContent = getInitials(sender);
        }
        msgDiv.appendChild(avatar);
    }

    const content = document.createElement("div");
    content.className = "message-content";

    const bubble = document.createElement("div");
    bubble.className = "message-bubble";

    // Sender name (only for first in cluster and only for groups)
    if (!isCluster && sender !== username && (data.group_id || (currentRecipient && String(currentRecipient).startsWith('group_')))) {
        const senderName = document.createElement("div");
        senderName.className = "sender-name";
        senderName.textContent = sender;
        senderName.onclick = () => showUserProfile(sender);
        bubble.appendChild(senderName);
    }

    // Message content
    const msgContent = document.createElement("div");

    if (data.message_type === 'image' && data.file_url) {
        const img = document.createElement("img");
        img.src = data.file_url;
        img.className = "message-image";
        img.onclick = () => window.open(data.file_url, '_blank');
        msgContent.appendChild(img);
    } else if (data.message_type === 'voice' && data.file_url) {
        const audioDiv = document.createElement("div");
        audioDiv.className = "message-voice";
        audioDiv.innerHTML = `
            <div class="voice-player">
                <button class="voice-play-btn" onclick="toggleVoicePlay(this, '${data.file_url}')">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                        <polygon points="5 3 19 12 5 21 5 3"></polygon>
                    </svg>
                </button>
                <div class="voice-waveform">
                    <div class="voice-progress" data-duration="0"></div>
                    <div class="voice-time">0:00</div>
                </div>
                <audio src="${data.file_url}" preload="metadata"></audio>
            </div>
        `;
        msgContent.appendChild(audioDiv);
    } else if (data.message_type === 'file' && data.file_url) {
        const fileDiv = document.createElement("div");
        fileDiv.className = "message-file";
        fileDiv.innerHTML = `
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink: 0;"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path><polyline points="13 2 13 9 20 9"></polyline></svg>
            <a href="${data.file_url}" download="${data.file_name}" style="color: inherit; text-decoration: none; flex: 1; margin-left: 8px;">
                ${data.file_name || 'Download file'}
            </a>
        `;
        msgContent.appendChild(fileDiv);
    } else {
        const msgText = document.createElement("p");
        msgText.className = "message-text";
        msgText.textContent = message;
        msgContent.appendChild(msgText);
    }
    // Cache message by id for later lookups (used by reply previews and jump-to-original)
    try {
        if (msgId) {
            window.messageIndex[msgId] = { text: message, sender: sender, timestamp: data.timestamp };
            console.log('messageIndex store', msgId, window.messageIndex[msgId]);
        }
    } catch (e) {
        console.warn('messageIndex store failed', e);
    }

    // Reply preview block (if present) — make robust: use server-sent preview, cached message, or fetch from server
    if (data.reply_preview || data.reply_to_id) {
        console.log('appendMessage: has reply_to_id', data.reply_to_id, 'reply_preview:', data.reply_preview);
        let previewText = data.reply_preview || '';
        let previewSender = data.reply_preview_sender || '';
        const replyId = data.reply_to_id;

        if (!previewText && replyId && window.messageIndex && window.messageIndex[replyId]) {
            previewText = window.messageIndex[replyId].text;
            previewSender = window.messageIndex[replyId].sender;
        }

        const replyBlock = document.createElement('div');
        replyBlock.className = 'reply-preview';
        replyBlock.dataset.replyTo = replyId || '';
        replyBlock.innerHTML = `<div class="reply-sender-small">${previewSender || ''}</div><div class="reply-text-small">${previewText || 'Reply'}</div>`;
        replyBlock.style.cursor = 'pointer';
        replyBlock.title = 'Jump to original message';
        replyBlock.onclick = () => {
            if (replyId) jumpToOriginal(replyId);
            else showNotification('Original message not available');
        };

        // If we don't have preview text yet, ask server to fetch it (will update when response arrives)
        if (!previewText && replyId) {
            console.log('appendMessage: preview not found locally, attempting server fetch for', replyId);
            try {
                socket.emit('fetch_message_by_id', { message_id: replyId });
                // show fetching indicator
                const small = replyBlock.querySelector('.reply-text-small');
                if (small) small.textContent = 'Fetching…';
            } catch (e) {
                console.warn('fetch_message_by_id emit failed', e);
            }
        }

        // Insert reply block at top of bubble
        bubble.insertBefore(replyBlock, bubble.firstChild);
    }

    bubble.appendChild(msgContent);

    // Meta info
    // message-meta intentionally omitted (timestamp removed for now)
    const meta = document.createElement("div");
    meta.className = "message-meta";
    // keep edited flag visible without timestamp
    if (data.edited) {
        meta.textContent = 'edited';
        bubble.appendChild(meta);
    }

    // Reactions
    if (data.reactions && data.reactions.length > 0) {
        const reactionsDiv = document.createElement("div");
        reactionsDiv.className = "message-reactions";
        reactionsDiv.dataset.messageId = data.id;
        renderReactions(reactionsDiv, data.reactions);
        bubble.appendChild(reactionsDiv);
    }

    content.appendChild(bubble);
    msgDiv.appendChild(content);
    msgContainer.appendChild(msgDiv);
    // attach interactions
    try { attachMessageInteraction(msgDiv, msgDiv.dataset.messageId, sender); } catch (e) { }
    // update last-message preview
    updateLastMessagePreview(sender, message, data.timestamp);
    lastMessageSender = sender;
    // If user was at bottom, auto-scroll. Otherwise show new messages indicator.
    if (wasAtBottom) {
        msgContainer.scrollTop = msgContainer.scrollHeight;
        hideNewMessagesIndicator();
    } else {
        showNewMessagesIndicator();
    }

    // Subtle arrival animation highlight on bubble
    try {
        bubble.classList.add('arrival');
        setTimeout(() => bubble.classList.remove('arrival'), 700);
    } catch (e) { }
}

// Unread badge helpers
window.unreadCounts = window.unreadCounts || {};
function incrementUnreadBadge(usernameKey) {
    window.unreadCounts[usernameKey] = (window.unreadCounts[usernameKey] || 0) + 1;
    const item = document.querySelector(`#userList li[data-username="${usernameKey}"]`);
    if (item) {
        const badge = item.querySelector('.unread-badge');
        if (badge) {
            badge.textContent = window.unreadCounts[usernameKey];
            badge.style.display = 'inline-block';
        }
    }
}

function clearUnread(usernameKey) {
    window.unreadCounts[usernameKey] = 0;
    const item = document.querySelector(`#userList li[data-username="${usernameKey}"]`);
    if (item) {
        const badge = item.querySelector('.unread-badge');
        if (badge) badge.style.display = 'none';
    }
}

function updateLastMessagePreview(usernameKey, text, timestamp) {
    window.lastMessages = window.lastMessages || {};
    window.lastMessages[usernameKey] = { text, timestamp };
    const item = document.querySelector(`#userList li[data-username="${usernameKey}"]`);
    if (item) {
        const lastMsg = item.querySelector('.user-last-message');
        const meta = item.querySelector('.user-last-meta');
        if (lastMsg) lastMsg.textContent = text ? (text.length > 40 ? text.substring(0, 40) + '…' : text) : '';
        if (meta) meta.textContent = timestamp ? formatTime(timestamp) : '';
        // bump item to top (optional) -- commented out
        // item.parentNode.prepend(item);
    }
}

// Attach context menu and long-press handlers to a message div
function attachMessageInteraction(msgDiv, messageId, sender) {
    // right-click
    msgDiv.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const x = e.clientX;
        const y = e.clientY;
        showMessageOptionsAt(messageId, sender, x, y);
    });

    // long-press for touch devices
    let pressTimer = null;
    msgDiv.addEventListener('touchstart', (e) => {
        pressTimer = setTimeout(() => {
            const touch = e.touches[0];
            showMessageOptionsAt(messageId, sender, touch.clientX, touch.clientY);
        }, 600);
    });
    msgDiv.addEventListener('touchend', () => { if (pressTimer) clearTimeout(pressTimer); });
}

function showMessageOptionsAt(messageId, sender, x, y) {
    showMessageOptions(messageId, sender);
    const menu = document.querySelector('.message-options-menu');
    if (menu) {
        menu.style.left = (x + 8) + 'px';
        menu.style.top = (y + 8) + 'px';
    }
}

// Auto-scroll indicator helpers
function isMessagesAtBottom() {
    const el = byId('messages');
    if (!el) return true;
    return (el.scrollHeight - el.scrollTop - el.clientHeight) < 40;
}

function showNewMessagesIndicator() {
    const el = byId('newMessagesIndicator');
    if (!el) return;
    el.style.display = 'block';
}

function hideNewMessagesIndicator() {
    const el = byId('newMessagesIndicator');
    if (!el) return;
    el.style.display = 'none';
}

function renderReactions(container, reactions) {
    container.innerHTML = '';
    const reactionCounts = {};

    reactions.forEach(r => {
        if (!reactionCounts[r.emoji]) {
            reactionCounts[r.emoji] = { count: 0, users: [] };
        }
        reactionCounts[r.emoji].count++;
        reactionCounts[r.emoji].users.push(r.user);
    });

    Object.entries(reactionCounts).forEach(([emoji, data]) => {
        const reactionItem = document.createElement("span");
        reactionItem.className = "reaction-item";
        reactionItem.innerHTML = `${emoji} <span style="font-size: 11px; opacity: 0.7;">${data.count}</span>`;
        reactionItem.title = data.users.join(', ');
        reactionItem.onclick = () => toggleReaction(container.dataset.messageId, emoji);
        container.appendChild(reactionItem);
    });
}

function showTypingIndicator(sender, conversationId) {
    if (!conversationId) conversationId = sender;

    // Initialize set for this conversation if needed
    if (!typingUsers[conversationId]) {
        typingUsers[conversationId] = new Set();
    }

    // Add sender to typing users
    typingUsers[conversationId].add(sender);

    // Only show if viewing this conversation
    const isCurrentConversation =
        (conversationId === currentRecipient) ||
        (conversationId.startsWith('group_') && currentRecipient && currentRecipient.startsWith('group_'));

    if (!isCurrentConversation) return;

    // show header small typing status
    const headerStatus = byId('chat-partner-status');
    if (headerStatus && conversationId === currentRecipient) {
        const dot = headerStatus.querySelector('.status-dot');
        const text = headerStatus.querySelector('span:last-child');
        if (text) text.textContent = 'typing...';
        if (dot) dot.style.opacity = '0.7';
    }

    updateTypingIndicatorDisplay(conversationId);
}

function hideTypingIndicator(sender, conversationId) {
    if (!conversationId) conversationId = sender;

    if (typingUsers[conversationId]) {
        typingUsers[conversationId].delete(sender);

        if (typingUsers[conversationId].size === 0) {
            delete typingUsers[conversationId];
        }
    }

    updateTypingIndicatorDisplay(conversationId);
    const headerStatus = byId('chat-partner-status');
    if (headerStatus && conversationId === currentRecipient) {
        const dot = headerStatus.querySelector('.status-dot');
        const text = headerStatus.querySelector('span:last-child');
        if (text) text.textContent = userStatuses[currentRecipient] === 'online' ? 'Online' : (userStatuses[currentRecipient] || 'Offline');
        if (dot) dot.style.opacity = '';
    }
}

function updateTypingIndicatorDisplay(conversationId) {
    const existing = document.querySelector('.typing-indicator');

    if (!typingUsers[conversationId] || typingUsers[conversationId].size === 0) {
        if (existing) existing.remove();
        return;
    }

    const typingArray = Array.from(typingUsers[conversationId]);
    let text = '';

    if (typingArray.length === 1) {
        text = `${typingArray[0]} is typing`;
    } else if (typingArray.length === 2) {
        text = `${typingArray[0]} and ${typingArray[1]} are typing`;
    } else if (typingArray.length === 3) {
        text = `${typingArray[0]}, ${typingArray[1]}, and ${typingArray[2]} are typing`;
    } else {
        text = `${typingArray[0]}, ${typingArray[1]}, and ${typingArray.length - 2} others are typing`;
    }

    if (existing) {
        existing.querySelector('span').textContent = text;
    } else {
        const indicator = document.createElement("div");
        indicator.className = "typing-indicator";
        indicator.dataset.conversation = conversationId;
        indicator.innerHTML = `
            <span style="font-size: 12px; color: var(--text-secondary);">${text}</span>
            <div class="typing-dots">
                <div class="typing-dot"></div>
                <div class="typing-dot"></div>
                <div class="typing-dot"></div>
            </div>
        `;
        byId('messages').appendChild(indicator);
        byId('messages').scrollTop = byId('messages').scrollHeight;
    }
}


function hideTypingIndicator(sender) {
    const indicator = document.querySelector(`.typing-indicator[data-sender="${sender}"]`);
    if (indicator) indicator.remove();
}

// ==================== VOICE RECORDING ====================
async function toggleVoiceRecording() {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
        stopRecording();
    } else {
        await startRecording();
    }
}

async function startRecording() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaRecorder = new MediaRecorder(stream);
        audioChunks = [];

        mediaRecorder.ondataavailable = (event) => {
            audioChunks.push(event.data);
        };

        mediaRecorder.onstop = async () => {
            const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
            await uploadVoiceMessage(audioBlob);

            // Stop all tracks
            stream.getTracks().forEach(track => track.stop());
        };

        mediaRecorder.start();
        recordingStartTime = Date.now();

        // Show recording indicator
        byId('recordingIndicator').classList.add('active');
        byId('micBtn').style.background = 'var(--error)';
        byId('micBtn').style.color = 'white';

        // Update timer
        recordingTimer = setInterval(() => {
            const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
            const minutes = Math.floor(elapsed / 60);
            const seconds = elapsed % 60;
            byId('recordingTime').textContent = `${minutes}:${seconds.toString().padStart(2, '0')}`;
        }, 1000);

        showNotification('Recording started...');
    } catch (error) {
        console.error('Error accessing microphone:', error);
        showNotification('Could not access microphone. Please check permissions.');
    }
}

function stopRecording() {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
        mediaRecorder.stop();
        clearInterval(recordingTimer);

        // Hide recording indicator
        byId('recordingIndicator').classList.remove('active');
        byId('micBtn').style.background = '';
        byId('micBtn').style.color = '';

        showNotification('Recording saved!');
    }
}

async function uploadVoiceMessage(blob) {
    const formData = new FormData();
    const filename = `voice_${Date.now()}.webm`;
    formData.append('file', blob, filename);

    try {
        const response = await fetch('/upload_file', {
            method: 'POST',
            body: formData
        });
        const data = await response.json();

        if (data.success) {
            sendFileMessage(data.file_url, filename, 'voice');
        } else {
            showNotification('Voice upload failed: ' + data.error);
        }
    } catch (error) {
        showNotification('Voice upload error');
    }
}

// ==================== FILE UPLOAD ====================
async function handleFileUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('file', file);

    try {
        const response = await fetch('/upload_file', {
            method: 'POST',
            body: formData
        });
        const data = await response.json();

        if (data.success) {
            sendFileMessage(data.file_url, data.file_name, data.file_type);
        } else {
            showNotification('File upload failed: ' + data.error);
        }
    } catch (error) {
        showNotification('File upload error');
    }

    event.target.value = '';
}

function sendFileMessage(fileUrl, fileName, fileType) {
    if (!currentRecipient) return;

    const isGroup = allGroups.some(g => g.name === currentRecipient);

    if (isGroup) {
        socket.emit("send_group_message", {
            sender: username,
            group_name: currentRecipient,
            message: fileName,
            message_type: fileType,
            file_url: fileUrl,
            file_name: fileName
        });
    } else {
        socket.emit("send_message", {
            sender: username,
            recipient: currentRecipient,
            message: fileName,
            message_type: fileType,
            file_url: fileUrl,
            file_name: fileName
        });
    }
}

// ==================== SEND MESSAGE ====================
function sendMessage() {
    const input = byId('messageInput');
    const text = input.value.trim();

    if (text && currentRecipient) {
        const isGroup = allGroups.some(g => g.name === currentRecipient);

        const messageData = {
            sender: username,
            message: text,
            message_type: 'text'
        };

        if (replyToMessage) {
            // send numeric id to server for DB lookup
            messageData.reply_to_id = Number(replyToMessage.id);
        }

        if (isGroup) {
            messageData.group_name = currentRecipient;
            socket.emit("send_group_message", messageData);
        } else {
            messageData.recipient = currentRecipient;
            console.log('sendMessage emitting send_message', messageData);
            socket.emit("send_message", messageData);
        }

        input.value = "";
        input.style.height = 'auto';
        cancelReply();

        // Send stop typing with group_id if in group chat
        const stopTypingData = { sender: username };
        if (isGroup) {
            stopTypingData.group_id = parseInt(currentRecipient.split('_')[1]);
        } else {
            stopTypingData.recipient = currentRecipient;
        }
        socket.emit("stop_typing", stopTypingData);
    }
}

function handleKey(event) {
    if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        sendMessage();
    }
}

function handleTyping() {
    const input = byId('messageInput');

    // Auto-resize
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';

    if (!currentRecipient) return;

    // Send typing with group_id if in group chat
    const isGroup = currentRecipient && currentRecipient.startsWith('group_');
    const typingData = { sender: username };
    if (isGroup) {
        typingData.group_id = parseInt(currentRecipient.split('_')[1]);
    } else {
        typingData.recipient = currentRecipient;
    }
    socket.emit("typing", typingData);

    if (typingTimeout) clearTimeout(typingTimeout);

    typingTimeout = setTimeout(() => {
        const stopTypingData = { sender: username };
        const isGroupCheck = currentRecipient && currentRecipient.startsWith('group_');
        if (isGroupCheck) {
            stopTypingData.group_id = parseInt(currentRecipient.split('_')[1]);
        } else {
            stopTypingData.recipient = currentRecipient;
        }
        socket.emit("stop_typing", stopTypingData);
    }, 2000);
}

// ==================== REACTIONS ====================
function toggleReaction(messageId, emoji) {
    socket.emit("remove_reaction", {
        message_id: messageId,
        user: username,
        emoji: emoji
    });
}

// ==================== GROUP CREATION ====================
function openGroupModal() {
    const modal = byId('groupModal');
    const membersList = byId('membersList');

    membersList.innerHTML = '';
    allUsers.forEach(user => {
        const label = document.createElement('label');
        label.className = 'checkbox-group';
        label.style.display = 'flex';
        label.style.padding = '8px';
        label.innerHTML = `
            <input type="checkbox" value="${user}" class="group-member-checkbox">
            <span style="margin-left: 8px;">${user}</span>
        `;
        membersList.appendChild(label);
    });

    modal.style.display = 'flex';
}

function closeGroupModal() {
    byId('groupModal').style.display = 'none';
    byId('groupName').value = '';
}

function createGroup() {
    const groupName = byId('groupName').value.trim();
    const checkboxes = document.querySelectorAll('.group-member-checkbox:checked');
    const members = Array.from(checkboxes).map(cb => cb.value);

    if (!groupName) {
        showNotification('Please enter a group name');
        return;
    }

    if (members.length === 0) {
        showNotification('Please select at least one member');
        return;
    }

    socket.emit("create_group", {
        creator: username,
        name: groupName,
        members: [...members, username]
    });

    closeGroupModal();
    showNotification('Creating group...');
}

// ==================== SEARCH ====================
function openSearchModal() {
    byId('searchModal').style.display = 'flex';
    byId('searchQuery').value = '';
    byId('searchResults').innerHTML = '';
}

function closeSearchModal() {
    byId('searchModal').style.display = 'none';
}

byId('searchQuery').addEventListener('input', function () {
    const query = this.value.trim();
    if (query.length >= 2 && currentRecipient) {
        socket.emit("search_messages", {
            user: username,
            partner: currentRecipient,
            query: query
        });
    }
});

// ==================== SETTINGS ====================
function openSettingsModal() {
    byId('settingsModal').style.display = 'flex';
    socket.emit("get_privacy_settings", { username });
}

function closeSettingsModal() {
    byId('settingsModal').style.display = 'none';
}

function saveSettings() {
    const status = byId('statusSelect').value;
    const statusMessage = byId('statusMessage').value;
    const showLastSeen = byId('showLastSeen').checked;
    const showReadReceipts = byId('showReadReceipts').checked;

    socket.emit("update_status", {
        username,
        status,
        status_message: statusMessage
    });

    socket.emit("update_privacy_settings", {
        username,
        show_last_seen: showLastSeen,
        show_read_receipts: showReadReceipts,
        allow_messages_from: 'everyone'
    });

    closeSettingsModal();
    showNotification('Settings saved!');
}

// ==================== CHAT ACTIONS ====================
function clearChatHistory() {
    if (currentRecipient && confirm(`Clear all chat history with ${currentRecipient}?`)) {
        socket.emit("clear_history", { user1: username, user2: currentRecipient });
    }
}

// ==================== SOCKET EVENTS ====================
socket.on("connect", () => {
    console.log("Connected to server");
    // Clear any login error messages
    const loginError = byId('login-error');
    const registerError = byId('register-error');
    if (loginError) loginError.style.display = 'none';
    if (registerError) registerError.style.display = 'none';

    if (username) {
        socket.emit("register_user", username);
        socket.emit("update_status", { username, status: "online" });
        socket.emit("get_user_groups", { username });
    }
});

socket.on("connect_error", (error) => {
    console.error("Connection error:", error);
    const loginError = byId('login-error');
    const registerError = byId('register-error');
    if (loginError && loginError.parentElement.style.display !== 'none') {
        loginError.textContent = 'Connection issue. Retrying...';
        loginError.style.display = 'block';
    }
});

socket.on("reconnect", (attemptNumber) => {
    console.log("Reconnected after", attemptNumber, "attempts");
    if (username) {
        socket.emit("register_user", username);
        socket.emit("update_status", { username, status: "online" });
        socket.emit("get_user_groups", { username });

        // Re-join current chat if open
        if (currentRecipient) {
            joinRoom(currentRecipient, isGroupChat);
        }
    }
});

socket.on("reconnect_error", (error) => {
    console.error("Reconnection error:", error);
});

socket.on("reconnect_failed", () => {
    console.error("Reconnection failed");
    // Only show alert if completely failed after all attempts
    // showNotification("Connection lost. Please refresh the page."); 
});

socket.on("disconnect", () => {
    console.log("Disconnected from server");
});

socket.on("update_users", data => {
    // Handle both old format (array) and new format (object with users and avatars)
    if (Array.isArray(data)) {
        updateUserList(data);
    } else {
        allUsers = data.users || [];
        if (data.user_data) {
            // Store user data including avatars
            window.userData = data.user_data;
        }
        updateUserList(data.users || data);
    }
});

socket.on("chat_history", data => {
    const { history, key } = data;
    sharedKeys[currentRecipient] = key;
    byId('messages').innerHTML = "";
    lastMessageDate = null;
    lastMessageSender = null;
    history.forEach(msg => {
        appendMessage(msg.sender, msg.message, msg);
    });
});

socket.on("history_cleared", () => {
    byId('messages').innerHTML = "";
    lastMessageDate = null;
    lastMessageSender = null;
    showNotification("Chat history cleared");
});

socket.on("receive_message", data => {
    console.log('receive_message payload:', data);
    const partner = data.sender === username ? currentRecipient : data.sender;
    if (partner && data.key) {
        sharedKeys[partner] = data.key;
    }

    if (data.sender === currentRecipient || (data.sender === username && partner === currentRecipient)) {
        appendMessage(data.sender, data.message, data);

        if (data.sender === currentRecipient) {
            socket.emit("message_delivered", { id: data.id });
        }
    } else if (data.sender !== username) {
        showNotification(`New message from ${data.sender}`);
        // increment unread count and badge
        incrementUnreadBadge(data.sender);
    }
});

socket.on("user_typing", data => {
    const conversationId = data.conversation_id || data.sender;
    showTypingIndicator(data.sender, conversationId);
});

socket.on("user_stopped_typing", data => {
    const conversationId = data.conversation_id || data.sender;
    hideTypingIndicator(data.sender, conversationId);
});

socket.on("user_status_changed", data => {
    userStatuses[data.username] = data.status;

    // Update UI
    const userItem = document.querySelector(`[data-username="${data.username}"]`);
    if (userItem) {
        const badge = userItem.querySelector('.user-status-badge');
        if (badge) {
            badge.className = 'user-status-badge ' + getUserStatusClass(data.status);
        }
    }

    if (data.username === currentRecipient) {
        updateRecipientStatus(data);
    }
});

socket.on("user_status_info", data => {
    if (data.username === currentRecipient) {
        updateRecipientStatus(data);
    }
});

function updateRecipientStatus(data) {
    const statusText = byId('chat-partner-status');

    let statusStr = data.status.charAt(0).toUpperCase() + data.status.slice(1);
    if (data.status_message) {
        statusStr = data.status_message;
    }

    statusText.innerHTML = `<span class="status-dot ${getUserStatusClass(data.status)}"></span><span>${statusStr}</span>`;
}

socket.on("search_results", data => {
    const resultsDiv = byId('searchResults');
    resultsDiv.innerHTML = '';

    if (data.results.length === 0) {
        resultsDiv.innerHTML = '<p style="text-align: center; color: var(--text-tertiary); padding: 20px;">No results found</p>';
        return;
    }

    data.results.forEach(result => {
        const resultDiv = document.createElement("div");
        resultDiv.style.padding = "12px";
        resultDiv.style.borderBottom = "1px solid var(--border-color)";
        resultDiv.style.cursor = "pointer";
        resultDiv.innerHTML = `
            <strong style="color: var(--text-primary);">${result.sender}</strong>
            <p style="color: var(--text-secondary); margin: 4px 0;">${result.message}</p>
            <small style="color: var(--text-tertiary);">${new Date(result.timestamp).toLocaleString()}</small>
        `;
        resultsDiv.appendChild(resultDiv);
    });
});

socket.on("privacy_settings_info", data => {
    byId('showLastSeen').checked = data.show_last_seen;
    byId('showReadReceipts').checked = data.show_read_receipts;
});

socket.on("group_created", data => {
    showNotification(`Group "${data.name}" created successfully!`);
    socket.emit("get_user_groups", { username });
});

socket.on("user_groups", data => {
    allGroups = data.groups || [];
    console.log('Received groups:', allGroups);
    updateUserList(allUsers);
});

socket.on("group_history", data => {
    const { history } = data;
    byId('messages').innerHTML = "";
    lastMessageDate = null;
    lastMessageSender = null;
    history.forEach(msg => {
        appendMessage(msg.sender, msg.message, msg);
    });
});

socket.on("group_message", data => {
    if (data.group_name === currentRecipient) {
        appendMessage(data.sender, data.message, data);
    } else {
        showNotification(`New message in ${data.group_name}`);
    }
});


// Close modals when clicking outside
window.onclick = function (event) {
    if (event.target.classList.contains('modal')) {
        event.target.style.display = 'none';
    }
};

// Check session on load
window.addEventListener('DOMContentLoaded', async () => {
    try {
        const response = await fetch('/check_session');
        const data = await response.json();
        if (data.logged_in) {
            startChatSession(data.username);
        }
    } catch (error) {
        console.log('No active session');
    }
});

// ==================== MESSAGE EDITING & DELETION ====================
function showMessageOptions(messageId, sender) {
    const existingMenu = document.querySelector('.message-options-menu');
    if (existingMenu) existingMenu.remove();

    const menu = document.createElement('div');
    menu.className = 'message-options-menu';
    menu.innerHTML = `
        <div class="menu-item" onclick="replyToMessageFunc(${messageId})">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="9 14 4 9 9 4"></polyline>
                <path d="M20 20v-7a4 4 0 0 0-4-4H4"></path>
            </svg>
            Reply
        </div>
        <div class="menu-item" onclick="addReactionToMessage(${messageId})">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10"></circle>
                <path d="M8 14s1.5 2 4 2 4-2 4-2"></path>
                <line x1="9" y1="9" x2="9.01" y2="9"></line>
                <line x1="15" y1="9" x2="15.01" y2="9"></line>
            </svg>
            React
        </div>
        ${sender === username ? `
            <div class="menu-item" onclick="editMessage(${messageId})">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
                </svg>
                Edit
            </div>
            <div class="menu-item" onclick="deleteMessage(${messageId}, true)">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="3 6 5 6 21 6"></polyline>
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                </svg>
                Delete for Everyone
            </div>
        ` : ''}
        <div class="menu-item" onclick="deleteMessage(${messageId}, false)">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="3 6 5 6 21 6"></polyline>
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
            </svg>
            Delete for Me
        </div>
    `;
    document.body.appendChild(menu);
    // Default center position; if caller supplied coordinates, they will be applied by caller.
    menu.style.left = (window.innerWidth / 2 - menu.offsetWidth / 2) + 'px';
    menu.style.top = (window.innerHeight / 2 - menu.offsetHeight / 2) + 'px';

    setTimeout(() => {
        document.addEventListener('click', function closeMenu(e) {
            if (!menu.contains(e.target)) {
                menu.remove();
                document.removeEventListener('click', closeMenu);
            }
        });
    }, 100);
}

function editMessage(messageId) {
    const messageDiv = document.querySelector(`[data-message-id="${messageId}"]`);
    if (!messageDiv) return;

    const messageText = messageDiv.querySelector('.message-text');
    if (!messageText) return;

    const originalText = messageText.textContent;
    const input = document.createElement('textarea');
    input.value = originalText;
    input.className = 'message-edit-input';
    input.style.cssText = 'width: 100%; padding: 8px; border: 1px solid var(--accent-primary); border-radius: 4px; background: var(--bg-secondary); color: var(--text-primary); font-family: inherit; resize: vertical;';

    const btnContainer = document.createElement('div');
    btnContainer.style.cssText = 'display: flex; gap: 8px; margin-top: 8px;';
    btnContainer.innerHTML = `
        <button class="btn-primary" style="padding: 4px 12px; font-size: 12px;" onclick="saveEditedMessage(${messageId}, this)">Save</button>
        <button class="btn-secondary" style="padding: 4px 12px; font-size: 12px;" onclick="cancelEdit(${messageId}, '${originalText.replace(/'/g, "\\'")}')">Cancel</button>
    `;

    messageText.replaceWith(input);
    input.parentNode.appendChild(btnContainer);
    input.focus();
}

function saveEditedMessage(messageId, button) {
    const messageDiv = document.querySelector(`[data-message-id="${messageId}"]`);
    const input = messageDiv.querySelector('.message-edit-input');
    const newText = input.value.trim();

    if (!newText) return;

    socket.emit('edit_message', {
        message_id: messageId,
        new_text: newText,
        editor: username
    });

    const messageText = document.createElement('p');
    messageText.className = 'message-text';
    messageText.textContent = newText;

    input.replaceWith(messageText);
    button.parentNode.remove();
}

function cancelEdit(messageId, originalText) {
    const messageDiv = document.querySelector(`[data-message-id="${messageId}"]`);
    const input = messageDiv.querySelector('.message-edit-input');

    const messageText = document.createElement('p');
    messageText.className = 'message-text';
    messageText.textContent = originalText;

    input.replaceWith(messageText);
    const btnContainer = messageDiv.querySelector('div[style*="display: flex"]');
    if (btnContainer) btnContainer.remove();
}

function deleteMessage(messageId, deleteForEveryone) {
    if (confirm(deleteForEveryone ? 'Delete this message for everyone?' : 'Delete this message for you?')) {
        socket.emit('delete_message', {
            message_id: messageId,
            deleter: username,
            delete_for_everyone: deleteForEveryone
        });
    }
}

function replyToMessageFunc(messageId) {
    const messageDiv = document.querySelector(`[data-message-id="${messageId}"]`);
    if (!messageDiv) return;

    const messageText = messageDiv.querySelector('.message-text')?.textContent || 'File';
    const sender = messageDiv.querySelector('.sender-name')?.textContent ||
        (messageDiv.classList.contains('sent') ? username : currentRecipient);

    replyToMessage = { id: String(messageId), text: messageText, sender: sender };
    console.log('replyToMessage set', replyToMessage);

    const replyPreview = document.getElementById('replyPreview') || createReplyPreview();
    replyPreview.querySelector('.reply-text').textContent = messageText;
    replyPreview.querySelector('.reply-sender').textContent = sender;
    replyPreview.style.display = 'flex';

    byId('messageInput').focus();
}

function createReplyPreview() {
    const preview = document.createElement('div');
    preview.id = 'replyPreview';
    preview.style.cssText = 'display: none; padding: 8px 12px; background: var(--bg-tertiary); border-left: 3px solid var(--accent-primary); margin: 8px 0; border-radius: 4px; align-items: center; justify-content: space-between;';
    preview.innerHTML = `
        <div style="flex: 1;">
            <div class="reply-sender" style="font-size: 12px; color: var(--accent-primary); font-weight: 600;"></div>
            <div class="reply-text" style="font-size: 13px; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;"></div>
        </div>
        <button onclick="cancelReply()" style="background: none; border: none; color: var(--text-secondary); cursor: pointer; padding: 4px;">×</button>
    `;
    byId('input-area').insertBefore(preview, byId('input-area').firstChild);
    return preview;
}

function cancelReply() {
    replyToMessage = null;
    const preview = document.getElementById('replyPreview');
    if (preview) preview.style.display = 'none';
}

function addReactionToMessage(messageId) {
    const reactions = ['👍', '❤️', '😂', '😮', '😢', '🎉', '🔥', '👏', '🙏', '😅', '🤔', '😍', '😎', '🤩', '🤝', '🎯', '🙌', '😴', '🫡', '💯', '✨'];
    const menu = document.createElement('div');
    menu.className = 'reaction-picker';
    menu.style.cssText = 'position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); background: var(--bg-secondary); padding: 12px; border-radius: 12px; box-shadow: var(--shadow-md); display: flex; gap: 8px; z-index: 10000;';

    reactions.forEach(emoji => {
        const btn = document.createElement('button');
        btn.textContent = emoji;
        btn.style.cssText = 'font-size: 24px; background: none; border: none; cursor: pointer; padding: 8px; border-radius: 8px; transition: all 0.2s;';
        btn.onmouseover = () => btn.style.background = 'var(--bg-hover)';
        btn.onmouseout = () => btn.style.background = 'none';
        btn.onclick = () => {
            socket.emit('add_reaction', {
                message_id: messageId,
                user: username,
                emoji: emoji
            });
            menu.remove();
        };
        menu.appendChild(btn);
    });

    document.body.appendChild(menu);
    setTimeout(() => {
        document.addEventListener('click', function closePicker(e) {
            if (!menu.contains(e.target)) {
                menu.remove();
                document.removeEventListener('click', closePicker);
            }
        });
    }, 100);
}

// ==================== PROFILE PICTURE ====================
async function uploadProfilePicture(file) {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('username', username);

    try {
        const response = await fetch('/upload_avatar', {
            method: 'POST',
            body: formData
        });
        const data = await response.json();

        if (data.success) {
            showNotification('Profile picture updated!');
            // Update UI with new avatar
            const avatars = document.querySelectorAll(`[data-username="${username}"] .user-avatar`);
            avatars.forEach(av => {
                av.style.backgroundImage = `url(${data.avatar_url})`;
                av.style.backgroundSize = 'cover';
                av.innerHTML = '';
            });
        } else {
            showNotification('Failed to upload picture: ' + data.error);
        }
    } catch (error) {
        showNotification('Upload error');
    }
}

// ==================== VOICE/VIDEO CALLS ====================
async function initiateCall(callType) {
    if (!currentRecipient || allGroups.some(g => g.name === currentRecipient)) {
        showNotification('Cannot call groups');
        return;
    }

    try {
        const constraints = {
            audio: true,
            video: callType === 'video'
        };

        localStream = await navigator.mediaDevices.getUserMedia(constraints);

        peerConnection = new RTCPeerConnection(iceServers);

        localStream.getTracks().forEach(track => {
            peerConnection.addTrack(track, localStream);
        });

        peerConnection.onicecandidate = event => {
            if (event.candidate) {
                socket.emit('ice_candidate', {
                    caller: username,
                    callee: currentRecipient,
                    candidate: event.candidate
                });
            }
        };

        peerConnection.ontrack = event => {
            const remoteVideo = document.getElementById('remoteVideo');
            if (remoteVideo) {
                remoteVideo.srcObject = event.streams[0];
            }
        };

        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);

        socket.emit('initiate_call', {
            caller: username,
            callee: currentRecipient,
            call_type: callType,
            offer: JSON.stringify(offer)
        });

        showCallUI(callType, 'outgoing');
    } catch (error) {
        console.error('Error initiating call:', error);
        showNotification('Could not access camera/microphone');
    }
}

async function answerCall(callId, offer) {
    console.log('Answer button clicked, callId:', callId, 'offer:', offer);
    try {
        const constraints = {
            audio: true,
            video: currentCall.call_type === 'video'
        };

        console.log('Getting user media with constraints:', constraints);
        localStream = await navigator.mediaDevices.getUserMedia(constraints);

        peerConnection = new RTCPeerConnection(iceServers);

        localStream.getTracks().forEach(track => {
            peerConnection.addTrack(track, localStream);
        });

        peerConnection.onicecandidate = event => {
            if (event.candidate) {
                socket.emit('ice_candidate', {
                    caller: username,
                    callee: currentCall.caller,
                    candidate: event.candidate
                });
            }
        };

        peerConnection.ontrack = event => {
            const remoteVideo = document.getElementById('remoteVideo');
            if (remoteVideo) {
                remoteVideo.srcObject = event.streams[0];
            }
        };

        console.log('Setting remote description');
        await peerConnection.setRemoteDescription(JSON.parse(offer));
        // After setting remote description, drain any queued ICE candidates
        if (pendingIceCandidates.length) {
            console.log('Draining', pendingIceCandidates.length, 'pending ICE candidates after answer');
            for (const pending of pendingIceCandidates) {
                try {
                    await peerConnection.addIceCandidate(new RTCIceCandidate(pending.candidate));
                } catch (err) {
                    console.warn('Error adding pending ICE candidate after answer:', err);
                }
            }
            pendingIceCandidates = [];
        }
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);

        console.log('Emitting answer_call');
        socket.emit('answer_call', {
            call_id: callId,
            answer: JSON.stringify(answer),
            callee: username
        });

        showCallUI(currentCall.call_type, 'active');
        console.log('Call answered successfully');
    } catch (error) {
        console.error('Error answering call:', error);
        showNotification('Could not access camera/microphone');
    }
}

function rejectCall(callId) {
    socket.emit('reject_call', {
        call_id: callId,
        callee: username
    });
    hideCallUI();
}

function endCall(suppressEmit = false) {
    // suppressEmit: when true, do not emit end notifications (prevents loops when handling remote end)
    if (!suppressEmit && currentCall) {
        // emit both names to increase compatibility with server handlers
        socket.emit('end_call', {
            call_id: currentCall.call_id,
            user: username
        });
        socket.emit('call_ended', {
            call_id: currentCall.call_id,
            user: username,
            duration: currentCall && currentCall.duration ? currentCall.duration : 0
        });
    }

    if (peerConnection) {
        try { peerConnection.close(); } catch (e) { }
        peerConnection = null;
    }

    if (localStream) {
        try { localStream.getTracks().forEach(track => track.stop()); } catch (e) { }
        localStream = null;
    }

    hideCallUI();
    currentCall = null;
}

function showCallUI(callType, status) {
    let callUI = document.getElementById('callUI');
    if (!callUI) {
        callUI = document.createElement('div');
        callUI.id = 'callUI';
        callUI.style.cssText = 'position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.95); z-index: 10000; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 20px; box-sizing: border-box;';
        callUI.innerHTML = `
            <div style="text-align: center; margin-bottom: 20px; color: white;">
                <div style="font-size: 24px; font-weight: 600; margin-bottom: 8px;">${status === 'outgoing' ? 'Calling...' : 'On Call'}</div>
                <div style="font-size: 18px; opacity: 0.8;">${currentRecipient || currentCall.caller}</div>
            </div>
            <video id="remoteVideo" autoplay playsinline style="width: 80%; max-width: 800px; border-radius: 12px; margin-bottom: 20px; background: #333;"></video>
            <video id="localVideo" autoplay playsinline muted style="position: absolute; top: 20px; right: 20px; width: 150px; height: 100px; border-radius: 8px; border: 2px solid var(--accent-primary); object-fit: cover;"></video>
            <div style="display: flex; gap: 20px; margin-top: 20px;">
                <button onclick="endCall()" class="call-btn end" style="background: #ff4757; color: white; border: none; padding: 16px 32px; border-radius: 50px; cursor: pointer; font-size: 16px; font-weight: 600; min-width: 120px;">
                    End Call
                </button>
            </div>
        `;
        document.body.appendChild(callUI);
    }

    const localVideo = document.getElementById('localVideo');
    if (localStream && localVideo) {
        localVideo.srcObject = localStream;
    }

    if (callType === 'voice') {
        document.getElementById('localVideo').style.display = 'none';
        document.getElementById('remoteVideo').style.display = 'none';
        // Add a voice call indicator
        const voiceIndicator = document.createElement('div');
        voiceIndicator.id = 'voiceCallIndicator';
        voiceIndicator.style.cssText = 'width: 120px; height: 120px; border-radius: 50%; background: var(--accent-primary); display: flex; align-items: center; justify-content: center; margin: 20px auto;';
        voiceIndicator.innerHTML = '<svg width="60" height="60" viewBox="0 0 24 24" fill="white"><path d="M12 1c-1.1 0-2 .9-2 2v8c0 1.1.9 2 2 2s2-.9 2-2V3c0-1.1-.9-2-2-2zm0 16c-2.76 0-5-2.24-5-5V9c0-.55-.45-1-1-1s-1 .45-1 1v3c0 3.87 3.13 7 7 7s7-3.13 7-7V9c0-.55-.45-1-1-1s-1 .45-1 1v3c0 2.76-2.24 5-5 5z"/></svg>';
        const remoteVideo = document.getElementById('remoteVideo');
        remoteVideo.parentNode.insertBefore(voiceIndicator, remoteVideo);
    }
}

function hideCallUI() {
    const callUI = document.getElementById('callUI');
    const voiceIndicator = document.getElementById('voiceCallIndicator');
    if (callUI) callUI.remove();
    if (voiceIndicator) voiceIndicator.remove();
}

function handleAnswerClick(button) {
    const callId = button.dataset.callId;
    const offer = button.dataset.offer;
    console.log('Answer button clicked via handler, callId:', callId, 'offer length:', offer ? offer.length : 'undefined');
    if (!offer) {
        console.error('No offer data found on button');
        return;
    }
    answerCall(callId, offer);
    setTimeout(() => {
        const notification = button.closest('.notification');
        if (notification) notification.remove();
    }, 100);
}

function showIncomingCallNotification(caller, callType, callId, offer) {
    console.log('Showing incoming call notification for callId:', callId, 'offer length:', offer ? offer.length : 'undefined');
    const notification = document.createElement('div');
    notification.className = 'notification';
    notification.style.cssText = 'position: fixed; top: 20px; right: 20px; background: var(--bg-secondary); padding: 20px; border-radius: 12px; box-shadow: var(--shadow-md); z-index: 10001; min-width: 300px;';

    // Create elements instead of innerHTML to avoid string escaping issues
    const contentDiv = document.createElement('div');
    contentDiv.style.marginBottom = '16px';

    const titleDiv = document.createElement('div');
    titleDiv.style.fontSize = '18px';
    titleDiv.style.fontWeight = '600';
    titleDiv.style.color = 'var(--text-primary)';
    titleDiv.textContent = `Incoming ${callType} call`;

    const callerDiv = document.createElement('div');
    callerDiv.style.fontSize = '14px';
    callerDiv.style.color = 'var(--text-secondary)';
    callerDiv.style.marginTop = '4px';
    callerDiv.textContent = `from ${caller}`;

    contentDiv.appendChild(titleDiv);
    contentDiv.appendChild(callerDiv);

    const buttonsDiv = document.createElement('div');
    buttonsDiv.style.display = 'flex';
    buttonsDiv.style.gap = '12px';

    const answerButton = document.createElement('button');
    answerButton.className = 'btn-primary';
    answerButton.style.flex = '1';
    answerButton.textContent = 'Answer';
    answerButton.dataset.callId = callId;
    answerButton.dataset.offer = offer;
    answerButton.addEventListener('click', () => handleAnswerClick(answerButton));

    const declineButton = document.createElement('button');
    declineButton.className = 'btn-secondary';
    declineButton.style.flex = '1';
    declineButton.textContent = 'Decline';
    declineButton.addEventListener('click', () => {
        rejectCall(callId);
        notification.remove();
    });

    buttonsDiv.appendChild(answerButton);
    buttonsDiv.appendChild(declineButton);

    notification.appendChild(contentDiv);
    notification.appendChild(buttonsDiv);

    document.body.appendChild(notification);
    // Make visible (CSS .notification is hidden by default)
    notification.classList.add('show');
    console.log('Notification added to body with buttons');
}

// Socket handlers for calls
socket.on('incoming_call', data => {
    console.log('Received incoming_call:', data);
    currentCall = data;
    showIncomingCallNotification(data.caller, data.call_type, data.call_id, data.offer);
});

socket.on('call_answered', async data => {
    if (peerConnection) {
        await peerConnection.setRemoteDescription(JSON.parse(data.answer));
        // drain any pending ICE candidates that arrived before remoteDescription was set
        if (pendingIceCandidates.length) {
            console.log('Draining', pendingIceCandidates.length, 'pending ICE candidates');
            for (const pending of pendingIceCandidates) {
                try {
                    await peerConnection.addIceCandidate(new RTCIceCandidate(pending.candidate));
                } catch (err) {
                    console.warn('Error adding pending ICE candidate:', err);
                }
            }
            pendingIceCandidates = [];
        }
    }
});

socket.on('call_rejected', data => {
    showNotification('Call was declined');
    endCall();
});

socket.on('call_ended', data => {
    showNotification(`Call ended. Duration: ${data.duration || 0}s`);
    // End locally without re-emitting
    endCall(true);
});

// Some servers/clients may emit 'end_call' directly; listen for it too
socket.on('end_call', data => {
    showNotification(`Call ended by ${data.user || 'peer'}`);
    endCall(true);
});

socket.on('ice_candidate', async data => {
    // Buffer ICE candidates if remote description is not yet set
    if (!data || !data.candidate) return;
    const candidate = data.candidate;
    const fromUser = data.from || data.caller || null;
    if (peerConnection && peerConnection.remoteDescription && peerConnection.remoteDescription.type) {
        try {
            await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (error) {
            console.error('Error adding ICE candidate:', error);
        }
    } else {
        // store with metadata to filter later if needed
        pendingIceCandidates.push({ candidate, from: fromUser });
        console.log('Queued ICE candidate from', fromUser);
    }
});

// Socket handlers for message edit/delete
socket.on('message_edited', data => {
    const messageDiv = document.querySelector(`[data-message-id="${data.message_id}"]`);
    if (messageDiv) {
        const textEl = messageDiv.querySelector('.message-text');
        if (textEl) {
            textEl.textContent = data.new_text;
        }
        const meta = messageDiv.querySelector('.message-meta');
        if (meta && !meta.textContent.includes('edited')) {
            meta.textContent += ' • edited';
        }
    }
});

socket.on('message_deleted', data => {
    const messageDiv = document.querySelector(`[data-message-id="${data.message_id}"]`);
    if (messageDiv) {
        if (data.delete_for_everyone || data.deleter === username) {
            const textEl = messageDiv.querySelector('.message-text');
            if (textEl) {
                textEl.textContent = 'This message was deleted';
                textEl.style.fontStyle = 'italic';
                textEl.style.color = 'var(--text-tertiary)';
            }
        }
    }
});

// Handler for server response when fetching a message by id
socket.on('fetched_message', data => {
    if (!data || !data.message_id) return;
    const id = String(data.message_id);
    // Store in cache
    window.messageIndex = window.messageIndex || {};
    window.messageIndex[id] = { text: data.message || '', sender: data.sender || '', timestamp: data.timestamp };
    console.log('fetched_message received', id, window.messageIndex[id]);

    // Update any reply-preview placeholders that were waiting for this message
    const placeholders = document.querySelectorAll(`.reply-preview[data-reply-to="${id}"]`);
    placeholders.forEach(ph => {
        const senderEl = ph.querySelector('.reply-sender-small');
        const textEl = ph.querySelector('.reply-text-small');
        if (senderEl) senderEl.textContent = data.sender || '';
        if (textEl) textEl.textContent = data.message || '';
    });
});

function jumpToOriginal(messageId) {
    if (!messageId) return;
    const id = String(messageId);
    const el = document.querySelector(`[data-message-id="${id}"]`);
    if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('reply-target-highlight');
        setTimeout(() => el.classList.remove('reply-target-highlight'), 1400);
    } else {
        // If not found in DOM, ask server to fetch so user can navigate later
        socket.emit('fetch_message_by_id', { message_id: id });
        showNotification('Fetching original message...');
    }
}

// Add message long-press/right-click handler
document.addEventListener('DOMContentLoaded', () => {
    document.addEventListener('contextmenu', e => {
        const messageDiv = e.target.closest('.message');
        if (messageDiv) {
            e.preventDefault();
            const messageId = messageDiv.dataset.messageId;
            const sender = messageDiv.classList.contains('sent') ? username : currentRecipient;
            showMessageOptions(messageId, sender);
        }
    });
});

// ==================== GROUP MANAGEMENT ====================

let currentGroupId = null;

function openGroupSettingsModal(groupId) {
    currentGroupId = groupId;
    byId('groupSettingsModal').style.display = 'flex';

    // Load group details
    const group = allGroups.find(g => `group_${g.id}` === groupId);
    if (group) {
        byId('editGroupName').value = group.name;
        loadGroupMembers(group.id);
        loadGroupAdmins(group.id);
        populateAddMemberSelect(group.id);
    }
}

function closeGroupSettingsModal() {
    byId('groupSettingsModal').style.display = 'none';
    currentGroupId = null;
}

function loadGroupMembers(groupId) {
    const group = allGroups.find(g => g.id === groupId);
    if (!group) return;

    const membersList = byId('groupMembersList');
    membersList.innerHTML = '';

    group.members.forEach(member => {
        const memberDiv = document.createElement('div');
        memberDiv.style.cssText = 'display: flex; justify-content: space-between; align-items: center; padding: 8px; border-bottom: 1px solid var(--border-color);';
        memberDiv.innerHTML = `
            <span>${member}</span>
            ${group.creator !== member ? `<button class="btn-icon" onclick="removeMemberFromGroup('${member}')" style="color: var(--danger);">Remove</button>` : '<span style="color: var(--text-tertiary); font-size: 11px;">Creator</span>'}
        `;
        membersList.appendChild(memberDiv);
    });
}

function loadGroupAdmins(groupId) {
    socket.emit('get_group_admins', { group_id: groupId });
}

socket.on('group_admins', data => {
    const adminsList = byId('groupAdminsList');
    if (!adminsList) return;

    adminsList.innerHTML = '';

    data.admins.forEach(admin => {
        const adminDiv = document.createElement('div');
        adminDiv.style.cssText = 'display: flex; justify-content: space-between; align-items: center; padding: 8px; border-bottom: 1px solid var(--border-color);';

        const roleLabel = admin.role === 'creator' ? 'Creator' : 'Admin';
        const canDemote = admin.role !== 'creator';

        adminDiv.innerHTML = `
            <div>
                <div>${admin.username}</div>
                <div style="font-size: 11px; color: var(--text-tertiary);">${roleLabel}</div>
            </div>
            ${canDemote ? `<button class="btn-icon" onclick="demoteAdmin('${admin.username}')" style="color: var(--warning);">Demote</button>` : ''}
        `;
        adminsList.appendChild(adminDiv);
    });
});

function populateAddMemberSelect(groupId) {
    const group = allGroups.find(g => g.id === groupId);
    if (!group) return;

    const select = byId('addMemberSelect');
    select.innerHTML = '<option value="">Select a user...</option>';

    allUsers.filter(u => !group.members.includes(u)).forEach(user => {
        const option = document.createElement('option');
        option.value = user;
        option.textContent = user;
        select.appendChild(option);
    });
}

function updateGroupName() {
    const newName = byId('editGroupName').value.trim();
    if (!newName || !currentGroupId) return;

    const groupId = parseInt(currentGroupId.split('_')[1]);
    socket.emit('edit_group', {
        group_id: groupId,
        new_name: newName,
        editor: username
    });
}

function addMemberToGroup() {
    const selectedUser = byId('addMemberSelect').value;
    if (!selectedUser || !currentGroupId) return;

    const groupId = parseInt(currentGroupId.split('_')[1]);
    socket.emit('add_group_member', {
        group_id: groupId,
        username: selectedUser,
        adder: username
    });
}

function removeMemberFromGroup(memberUsername) {
    if (!currentGroupId) return;
    if (!confirm(`Remove ${memberUsername} from group?`)) return;

    const groupId = parseInt(currentGroupId.split('_')[1]);
    socket.emit('remove_group_member', {
        group_id: groupId,
        username: memberUsername,
        remover: username
    });
}

function promoteToAdmin(memberUsername) {
    if (!currentGroupId) return;

    const groupId = parseInt(currentGroupId.split('_')[1]);
    socket.emit('promote_to_admin', {
        group_id: groupId,
        username: memberUsername,
        promoter: username
    });
}

function demoteAdmin(adminUsername) {
    if (!currentGroupId) return;
    if (!confirm(`Demote ${adminUsername} from admin?`)) return;

    const groupId = parseInt(currentGroupId.split('_')[1]);
    socket.emit('demote_admin', {
        group_id: groupId,
        username: adminUsername,
        demoter: username
    });
}

function createInvitation() {
    const inviteUsername = byId('inviteUsername').value.trim();
    if (!inviteUsername || !currentGroupId) return;

    const groupId = parseInt(currentGroupId.split('_')[1]);
    socket.emit('create_group_invitation', {
        group_id: groupId,
        inviter: username,
        invited_user: inviteUsername
    });
}

// Socket handlers for group management
socket.on('promotion_success', data => {
    showNotification(data.message);
    if (currentGroupId) {
        loadGroupAdmins(parseInt(currentGroupId.split('_')[1]));
    }
});

socket.on('demotion_success', data => {
    showNotification(data.message);
    if (currentGroupId) {
        loadGroupAdmins(parseInt(currentGroupId.split('_')[1]));
    }
});

socket.on('member_add_success', data => {
    showNotification(data.message);
    socket.emit('get_user_groups', { username });
    if (currentGroupId) {
        const groupId = parseInt(currentGroupId.split('_')[1]);
        loadGroupMembers(groupId);
        populateAddMemberSelect(groupId);
    }
});

socket.on('member_remove_success', data => {
    showNotification(data.message);
    socket.emit('get_user_groups', { username });
    if (currentGroupId) {
        const groupId = parseInt(currentGroupId.split('_')[1]);
        loadGroupMembers(groupId);
        populateAddMemberSelect(groupId);
    }
});

socket.on('group_edit_success', data => {
    showNotification(data.message);
    socket.emit('get_user_groups', { username });
});

socket.on('invitation_created', data => {
    const linkDiv = byId('invitationLink');
    linkDiv.textContent = `Invitation token: ${data.invite_token}`;
    linkDiv.style.color = 'var(--success)';
    setTimeout(() => {
        linkDiv.textContent = '';
    }, 10000);
});

socket.on('group_invitation', data => {
    if (confirm(`${data.invited_by} invited you to join "${data.group_name}". Accept?`)) {
        socket.emit('accept_group_invitation', {
            invite_token: data.invite_token,
            username: username
        });
    }
});

socket.on('invitation_accepted', data => {
    showNotification(`Joined group: ${data.group_name}`);
    socket.emit('get_user_groups', { username });
});

socket.on('member_added', data => {
    showNotification(`${data.username} added to ${data.group_name}`);
    socket.emit('get_user_groups', { username });
});

socket.on('member_removed', data => {
    showNotification(`${data.username} removed from group`);
    socket.emit('get_user_groups', { username });
});

socket.on('removed_from_group', data => {
    showNotification(`You were removed from ${data.group_name}`);
    socket.emit('get_user_groups', { username });
    if (currentRecipient === `group_${data.group_id}`) {
        currentRecipient = null;
        byId('chatWindow').style.display = 'none';
    }
});

socket.on('user_promoted', data => {
    showNotification(`${data.username} promoted to admin`);
});

socket.on('user_demoted', data => {
    showNotification(`${data.username} demoted to member`);
});

socket.on('group_edited', data => {
    showNotification(`Group renamed to ${data.new_name}`);
    socket.emit('get_user_groups', { username });
});

socket.on('member_joined', data => {
    showNotification(`${data.username} joined ${data.group_name}`);
});

// ==================== MULTI-DEVICE SYNC ====================

function openMultiDeviceModal() {
    byId('multiDeviceModal').style.display = 'flex';
    loadDevices();
}

function closeMultiDeviceModal() {
    byId('multiDeviceModal').style.display = 'none';
    byId('qrCodeContainer').style.display = 'none';
}

function loadDevices() {
    socket.emit('get_devices', { username });
}

socket.on('devices_list', data => {
    const devicesList = byId('devicesList');
    if (!devicesList) return;

    devicesList.innerHTML = '';

    if (data.devices.length === 0) {
        devicesList.innerHTML = '<p style="text-align: center; color: var(--text-tertiary); padding: 16px;">No linked devices</p>';
        return;
    }

    data.devices.forEach(device => {
        const deviceDiv = document.createElement('div');
        deviceDiv.style.cssText = 'display: flex; justify-content: space-between; align-items: center; padding: 12px; border-bottom: 1px solid var(--border-color);';

        const lastActive = new Date(device.last_active);
        const timeAgo = getTimeAgo(lastActive);

        deviceDiv.innerHTML = `
            <div>
                <div style="font-weight: 500;">${device.device_name || 'Unknown Device'}</div>
                <div style="font-size: 11px; color: var(--text-tertiary);">${device.device_type} • Last active ${timeAgo}</div>
            </div>
            <button class="btn-icon" onclick="removeDevice(${device.id})" style="color: var(--danger);">Remove</button>
        `;
        devicesList.appendChild(deviceDiv);
    });
});

function getTimeAgo(date) {
    const seconds = Math.floor((new Date() - date) / 1000);
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
}

function removeDevice(deviceId) {
    if (!confirm('Remove this device?')) return;

    socket.emit('remove_device', {
        device_id: deviceId,
        username: username
    });
}

socket.on('device_removed', data => {
    showNotification('Device removed');
    loadDevices();
});

function generateQRCode() {
    socket.emit('generate_qr_code', { username });
}

socket.on('qr_code_generated', data => {
    const container = byId('qrCodeContainer');
    const display = byId('qrCodeDisplay');
    const expiry = byId('qrExpiry');

    // Clear previous QR code
    display.innerHTML = '';

    // Generate QR code using QRCode.js
    new QRCode(display, {
        text: data.token,
        width: 256,
        height: 256,
        colorDark: "#000000",
        colorLight: "#ffffff",
        correctLevel: QRCode.CorrectLevel.H
    });

    container.style.display = 'block';

    const expiresIn = data.expires_in;
    expiry.textContent = `Expires in ${Math.floor(expiresIn / 60)} minutes`;

    // Countdown
    let remaining = expiresIn;
    const interval = setInterval(() => {
        remaining--;
        if (remaining <= 0) {
            clearInterval(interval);
            container.style.display = 'none';
            display.innerHTML = '';
            showNotification('QR code expired');
        } else {
            expiry.textContent = `Expires in ${Math.floor(remaining / 60)}:${(remaining % 60).toString().padStart(2, '0')}`;
        }
    }, 1000);
});

function verifyQRCode() {
    const token = byId('qrTokenInput').value.trim();
    if (!token) return;

    socket.emit('verify_qr_code', {
        token: token,
        device_name: navigator.userAgent.includes('Mobile') ? 'Mobile Device' : 'Desktop',
        device_type: 'web'
    });
}

socket.on('device_paired', data => {
    showNotification(`Device paired: ${data.device_name}`);
    closeMultiDeviceModal();
    loadDevices();
});

socket.on('new_device_paired', data => {
    showNotification(`New device linked: ${data.device_name}`);
});

socket.on('messages_synced', data => {
    console.log(`Synced ${data.messages.length} messages`);
});

// Add settings button for multi-device
function addMultiDeviceButton() {
    const settingsBody = document.querySelector('#settingsModal .modal-body');
    if (settingsBody && !document.getElementById('multiDeviceBtn')) {
        const deviceBtn = document.createElement('button');
        deviceBtn.id = 'multiDeviceBtn';
        deviceBtn.className = 'btn btn-primary';
        deviceBtn.textContent = 'Manage Devices';
        deviceBtn.style.marginTop = '16px';
        deviceBtn.style.width = '100%';
        deviceBtn.onclick = () => {
            closeSettingsModal();
            openMultiDeviceModal();
        };
        settingsBody.appendChild(deviceBtn);
    }
}

// Add group settings button to chat header when in group
function addGroupSettingsButtonToHeader() {
    // Remove existing button if any
    const existingBtn = document.getElementById('groupSettingsBtn');
    if (existingBtn) existingBtn.remove();

    const chatHeader = document.querySelector('.chat-header-actions');
    if (chatHeader && currentRecipient && currentRecipient.startsWith('group_')) {
        const groupBtn = document.createElement('button');
        groupBtn.id = 'groupSettingsBtn';
        groupBtn.className = 'btn-icon';
        groupBtn.title = 'Group Settings';
        groupBtn.innerHTML = `
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="3"></circle>
                <path d="M12 1v6m0 6v6"></path>
                <path d="M21 12h-6m-6 0H3"></path>
            </svg>
        `;
        groupBtn.onclick = () => openGroupSettingsModal(currentRecipient);
        chatHeader.insertBefore(groupBtn, chatHeader.firstChild);
    }
}

// Update when settings modal opens
const originalOpenSettingsModal = window.openSettingsModal;
window.openSettingsModal = function () {
    if (originalOpenSettingsModal) originalOpenSettingsModal();
    else byId('settingsModal').style.display = 'flex';
    addMultiDeviceButton();
};

// ==================== QR SCANNER FOR LOGIN ====================

let qrScannerStream = null;
let qrScannerAnimationId = null;

function openQRScanner() {
    const modal = byId('qrScannerModal');
    const video = byId('qrVideo');
    const status = byId('qrScannerStatus');

    modal.style.display = 'flex';
    status.textContent = 'Starting camera...';

    // Request camera access
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
        .then(stream => {
            qrScannerStream = stream;
            video.srcObject = stream;
            video.play();
            status.textContent = 'Position QR code in the frame';
            scanQRCode();
        })
        .catch(err => {
            console.error('Camera access error:', err);
            status.textContent = 'Camera access denied. Please use manual token entry.';
            status.style.color = 'var(--error)';
        });
}

function closeQRScanner() {
    const modal = byId('qrScannerModal');
    const video = byId('qrVideo');
    const status = byId('qrScannerStatus');

    modal.style.display = 'none';

    // Stop camera
    if (qrScannerStream) {
        qrScannerStream.getTracks().forEach(track => track.stop());
        qrScannerStream = null;
    }

    // Stop scanning
    if (qrScannerAnimationId) {
        cancelAnimationFrame(qrScannerAnimationId);
        qrScannerAnimationId = null;
    }

    video.srcObject = null;
    status.textContent = 'Position QR code in the frame';
    status.style.color = 'var(--text-secondary)';
    byId('manualQRToken').value = '';
}

function scanQRCode() {
    const video = byId('qrVideo');
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    const status = byId('qrScannerStatus');

    function tick() {
        if (video.readyState === video.HAVE_ENOUGH_DATA) {
            canvas.height = video.videoHeight;
            canvas.width = video.videoWidth;
            context.drawImage(video, 0, 0, canvas.width, canvas.height);

            const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
            const code = jsQR(imageData.data, imageData.width, imageData.height, {
                inversionAttempts: "dontInvert",
            });

            if (code) {
                status.textContent = 'QR Code detected! Logging in...';
                status.style.color = 'var(--success)';

                // Process the scanned token
                processScannedToken(code.data);
                return; // Stop scanning
            }
        }

        qrScannerAnimationId = requestAnimationFrame(tick);
    }

    tick();
}

function processScannedToken(token) {
    // Verify the token with backend
    socket.emit('verify_qr_code', {
        token: token,
        device_name: navigator.userAgent.includes('Mobile') ? 'Mobile Device' : 'Desktop',
        device_type: 'web'
    });

    // Close scanner after a delay
    setTimeout(() => {
        closeQRScanner();
    }, 1500);
}

function loginWithManualToken() {
    const token = byId('manualQRToken').value.trim();
    if (!token) {
        showNotification('Please enter a token');
        return;
    }

    processScannedToken(token);
}

// Listen for successful device pairing to auto-login
socket.on('device_paired', data => {
    // Check if we're on the auth screen (QR login)
    const authScreen = byId('auth-screen');
    const isOnAuthScreen = authScreen && authScreen.style.display !== 'none';

    if (isOnAuthScreen && data.username) {
        // This is a QR login - auto-login the user
        showNotification(`Logging in as ${data.username}...`);
        username = data.username;

        // Register with socket
        socket.emit("register_user", { username: data.username });

        // Close QR scanner if open
        closeQRScanner();
    } else if (!isOnAuthScreen) {
        // Already logged in, just show notification
        showNotification(`Device paired: ${data.device_name}`);
        closeMultiDeviceModal();
        loadDevices();
    }
});

// ==================== VOICE PLAYER FUNCTIONS ====================

let currentAudio = null;
let currentAudioButton = null;

function toggleVoicePlay(btn, audioUrl) {
    const player = btn.closest('.voice-player');
    const progressBar = player.querySelector('.voice-progress');
    const timeDisplay = player.querySelector('.voice-time');
    const playIcon = btn.querySelector('polygon');

    // If clicking a different audio, stop current one
    if (currentAudio && currentAudioButton !== btn) {
        currentAudio.pause();
        currentAudioButton.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="white"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>';
    }

    // Create or reuse audio element
    if (!currentAudio || currentAudioButton !== btn) {
        currentAudio = new Audio(audioUrl);
        currentAudioButton = btn;

        // Update progress bar
        currentAudio.addEventListener('timeupdate', () => {
            const progress = (currentAudio.currentTime / currentAudio.duration) * 100;
            progressBar.style.setProperty('--progress', `${progress}%`);

            const mins = Math.floor(currentAudio.currentTime / 60);
            const secs = Math.floor(currentAudio.currentTime % 60);
            timeDisplay.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;
        });

        // When audio ends
        currentAudio.addEventListener('ended', () => {
            btn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="white"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>';
            progressBar.style.setProperty('--progress', '0%');
            const duration = Math.floor(currentAudio.duration);
            const mins = Math.floor(duration / 60);
            const secs = duration % 60;
            timeDisplay.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;
        });

        // Set initial duration
        currentAudio.addEventListener('loadedmetadata', () => {
            const duration = Math.floor(currentAudio.duration);
            const mins = Math.floor(duration / 60);
            const secs = duration % 60;
            timeDisplay.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;
        });
    }

    // Toggle play/pause
    if (currentAudio.paused) {
        currentAudio.play();
        btn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="white"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>';
    } else {
        currentAudio.pause();
        btn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="white"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>';
    }
}

// ==================== MOBILE SWIPE GESTURES ====================

let touchStartX = 0;
let touchStartY = 0;
let touchCurrentX = 0;
let swipedMessage = null;

document.addEventListener('DOMContentLoaded', () => {
    const messagesContainer = byId('messages');

    messagesContainer.addEventListener('touchstart', (e) => {
        const message = e.target.closest('.message');
        if (!message || message.classList.contains('system-message')) return;

        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
        swipedMessage = message;
    });

    messagesContainer.addEventListener('touchmove', (e) => {
        if (!swipedMessage) return;

        touchCurrentX = e.touches[0].clientX;
        const touchCurrentY = e.touches[0].clientY;
        const diffX = touchCurrentX - touchStartX;
        const diffY = touchCurrentY - touchStartY;

        // Only horizontal swipe
        if (Math.abs(diffY) > Math.abs(diffX)) return;

        // Limit swipe distance
        const maxSwipe = 80;
        const swipeAmount = Math.max(-maxSwipe, Math.min(maxSwipe, diffX));

        if (Math.abs(swipeAmount) > 10) {
            e.preventDefault();
            swipedMessage.style.transform = `translateX(${swipeAmount}px)`;

            // Show action buttons
            if (swipeAmount > 40) {
                swipedMessage.classList.add('swiped-right');
            } else if (swipeAmount < -40) {
                swipedMessage.classList.add('swiped-left');
            } else {
                swipedMessage.classList.remove('swiped-right', 'swiped-left');
            }
        }
    });

    messagesContainer.addEventListener('touchend', (e) => {
        if (!swipedMessage) return;

        const diffX = touchCurrentX - touchStartX;

        // Trigger actions
        if (diffX > 60) {
            // Swipe right - Reply
            const messageId = swipedMessage.dataset.messageId;
            const messageText = swipedMessage.querySelector('.message-text')?.textContent || 'Message';
            replyToMessage(messageId, messageText);
        } else if (diffX < -60) {
            // Swipe left - Delete (if own message)
            const messageId = swipedMessage.dataset.messageId;
            const isSent = swipedMessage.classList.contains('sent');
            if (isSent) {
                deleteMessage(messageId);
            }
        }

        // Reset
        swipedMessage.style.transform = '';
        swipedMessage.classList.remove('swiped-right', 'swiped-left');
        swipedMessage = null;
        touchStartX = 0;
        touchCurrentX = 0;
    });
});

// ==================== USER PROFILE MODAL ====================

let currentProfileUser = null;

function showUserProfile(targetUsername) {
    currentProfileUser = targetUsername;

    // Request profile data
    socket.emit('get_user_profile', { username: targetUsername });

    // Show modal
    byId('userProfileModal').style.display = 'flex';
    byId('profileUsername').textContent = `${targetUsername}'s Profile`;
    byId('profileUsernameField').value = targetUsername;
}

// ==================== Conversation and upload enhancements ====================
let conversationFilter = 'all';
let pinnedConversations = JSON.parse(localStorage.getItem('bb84:pinned-conversations') || '[]');

function setConversationFilter(filter, button) {
    conversationFilter = filter;
    document.querySelectorAll('.conversation-filter').forEach(el => el.classList.toggle('active', el === button));
    applyConversationFilter();
}

function toggleConversationPin(name, event) {
    if (event) event.stopPropagation();
    pinnedConversations = pinnedConversations.includes(name)
        ? pinnedConversations.filter(item => item !== name)
        : [...pinnedConversations, name];
    localStorage.setItem('bb84:pinned-conversations', JSON.stringify(pinnedConversations));
    applyConversationFilter();
}

function applyConversationFilter() {
    document.querySelectorAll('#userList li').forEach(item => {
        const name = item.dataset.username || '';
        const online = item.dataset.isGroup === 'true' || ['online', 'away', 'busy'].includes(userStatuses[name] || window.userData?.[name]?.status || 'online');
        const pinned = pinnedConversations.includes(name);
        item.classList.toggle('conversation-pinned', pinned);
        item.style.display = conversationFilter === 'online' && !online || conversationFilter === 'pinned' && !pinned ? 'none' : '';
        const pin = item.querySelector('.conversation-pin');
        if (pin) pin.textContent = pinned ? '★' : '☆';
    });
}

function decorateConversationItems() {
    document.querySelectorAll('#userList li').forEach(item => {
        if (item.querySelector('.conversation-pin')) return;
        const name = item.dataset.username;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'conversation-pin';
        button.title = 'Pin conversation';
        button.textContent = pinnedConversations.includes(name) ? '★' : '☆';
        button.onclick = event => toggleConversationPin(name, event);
        item.appendChild(button);
    });
    applyConversationFilter();
}

const bb84OriginalUpdateUserList = updateUserList;
updateUserList = function (users) {
    window.lastMessages = JSON.parse(localStorage.getItem(`bb84:last-messages:${username}`) || '{}');
    bb84OriginalUpdateUserList(users);
    decorateConversationItems();
};

const bb84OriginalUpdateLastMessagePreview = updateLastMessagePreview;
updateLastMessagePreview = function (usernameKey, text, timestamp) {
    bb84OriginalUpdateLastMessagePreview(usernameKey, text, timestamp);
    window.lastMessages = window.lastMessages || {};
    localStorage.setItem(`bb84:last-messages:${username}`, JSON.stringify(window.lastMessages));
    const item = document.querySelector(`#userList li[data-username="${CSS.escape(usernameKey)}"]`);
    if (item && item.parentElement) item.parentElement.prepend(item);
    decorateConversationItems();
};

const bb84OriginalIncrementUnread = incrementUnreadBadge;
incrementUnreadBadge = function (usernameKey) {
    bb84OriginalIncrementUnread(usernameKey);
    localStorage.setItem(`bb84:unread:${username}`, JSON.stringify(window.unreadCounts));
};
const bb84OriginalClearUnread = clearUnread;
clearUnread = function (usernameKey) {
    bb84OriginalClearUnread(usernameKey);
    localStorage.setItem(`bb84:unread:${username}`, JSON.stringify(window.unreadCounts));
    socket.emit('mark_as_read', { reader: username, sender: usernameKey });
};

async function uploadFileWithProgress(file) {
    if (!file || !currentRecipient) return;
    const progress = byId('uploadProgress');
    const bar = progress?.querySelector('span');
    if (progress) progress.classList.add('active');
    const formData = new FormData();
    formData.append('file', file);
    try {
        const data = await new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('POST', '/upload_file');
            xhr.upload.onprogress = event => { if (event.lengthComputable && bar) bar.style.width = `${Math.round(event.loaded / event.total * 100)}%`; };
            xhr.onload = () => { try { resolve(JSON.parse(xhr.responseText)); } catch (_) { reject(new Error('Invalid upload response')); } };
            xhr.onerror = () => reject(new Error('Upload failed'));
            xhr.send(formData);
        });
        if (!data.success) throw new Error(data.error || 'Upload failed');
        sendFileMessage(data.file_url, data.file_name, data.file_type);
    } catch (error) { showNotification(error.message); }
    finally { if (progress) { progress.classList.remove('active'); if (bar) bar.style.width = '0%'; } }
}

handleFileUpload = function (event) {
    const file = event.target.files[0];
    event.target.value = '';
    uploadFileWithProgress(file);
};

function addLinkPreview(messageDiv, text) {
    const url = (text || '').match(/https?:\/\/[^\s<]+/i)?.[0];
    if (!url || messageDiv.querySelector('.link-preview')) return;
    const preview = document.createElement('a');
    preview.className = 'link-preview';
    preview.href = url;
    preview.target = '_blank';
    preview.rel = 'noopener noreferrer';
    preview.textContent = url;
    const bubble = messageDiv.querySelector('.message-bubble');
    if (bubble) bubble.appendChild(preview);
}

const bb84OriginalAppendMessage = appendMessage;
appendMessage = function (sender, message, data = {}) {
    bb84OriginalAppendMessage(sender, message, data);
    const messageDiv = document.querySelector(`[data-message-id="${CSS.escape(String(data.id || ''))}"]`);
    if (messageDiv) {
        addLinkPreview(messageDiv, message);
        if (data.pinned) messageDiv.classList.add('pinned');
        if (data.starred) messageDiv.classList.add('starred');
    }
};

function copyMessage(messageId) {
    const text = document.querySelector(`[data-message-id="${messageId}"] .message-text`)?.textContent || '';
    navigator.clipboard?.writeText(text).then(() => showNotification('Message copied')).catch(() => showNotification('Copy unavailable'));
}

function toggleStarMessage(messageId) {
    socket.emit('star_message', { message_id: messageId, user: username });
}

function togglePinFromMenu(messageId) {
    if (!currentRecipient) return;
    socket.emit('pin_message', { message_id: messageId, recipient: currentRecipient, is_group: allGroups.some(g => g.name === currentRecipient) });
}

function showMessageOptions(messageId, sender) {
    document.querySelector('.message-options-menu')?.remove();
    const menu = document.createElement('div');
    menu.className = 'message-options-menu';
    const own = sender === username;
    menu.innerHTML = `<div class="menu-item" data-action="reply">↩ Reply</div><div class="menu-item" data-action="copy">▣ Copy</div><div class="menu-item" data-action="react">☺ React</div><div class="menu-item" data-action="pin">⚑ Pin</div><div class="menu-item" data-action="star">★ Star</div>${own ? '<div class="menu-item" data-action="edit">✎ Edit</div><div class="menu-item danger" data-action="delete">⌫ Delete</div>' : ''}`;
    menu.querySelectorAll('[data-action]').forEach(item => item.onclick = () => {
        const action = item.dataset.action;
        if (action === 'reply') replyToMessageFunc(messageId);
        if (action === 'copy') copyMessage(messageId);
        if (action === 'react') addReactionToMessage(messageId);
        if (action === 'pin') togglePinFromMenu(messageId);
        if (action === 'star') toggleStarMessage(messageId);
        if (action === 'edit') editMessage(messageId);
        if (action === 'delete') deleteMessage(messageId, true);
        menu.remove();
    });
    document.body.appendChild(menu);
    menu.style.left = `${Math.max(12, (window.innerWidth - menu.offsetWidth) / 2)}px`;
    menu.style.top = `${Math.max(12, (window.innerHeight - menu.offsetHeight) / 2)}px`;
}

deleteMessage = function (messageId, deleteForEveryone = true) {
    if (!confirm(deleteForEveryone ? 'Delete this message for everyone?' : 'Delete this message for you?')) return;
    socket.emit('delete_message', { message_id: messageId, username, delete_for_everyone: deleteForEveryone });
};

document.addEventListener('DOMContentLoaded', () => {
    const dropTarget = byId('input-area');
    if (!dropTarget) return;
    ['dragenter', 'dragover'].forEach(type => dropTarget.addEventListener(type, event => { event.preventDefault(); dropTarget.classList.add('drag-active'); }));
    ['dragleave', 'drop'].forEach(type => dropTarget.addEventListener(type, event => { event.preventDefault(); dropTarget.classList.remove('drag-active'); }));
    dropTarget.addEventListener('drop', event => [...(event.dataTransfer?.files || [])].forEach(uploadFileWithProgress));
    window.lastMessages = JSON.parse(localStorage.getItem(`bb84:last-messages:${username}`) || '{}');
});

socket.on('unread_counts', counts => {
    window.unreadCounts = { ...(JSON.parse(localStorage.getItem(`bb84:unread:${username}`) || '{}')), ...(counts || {}) };
    Object.entries(window.unreadCounts).forEach(([name, count]) => {
        const item = document.querySelector(`#userList li[data-username="${CSS.escape(name)}"]`);
        const badge = item?.querySelector('.unread-badge');
        if (badge && Number(count) > 0) { badge.textContent = count; badge.style.display = 'inline-block'; }
    });
});

socket.on('reaction_added', data => {
    const container = document.querySelector(`.message-reactions[data-message-id="${CSS.escape(String(data.message_id))}"]`);
    if (container) { const item = document.createElement('span'); item.className = 'reaction-item'; item.textContent = data.emoji; item.onclick = () => toggleReaction(data.message_id, data.emoji); container.appendChild(item); }
});
socket.on('reaction_removed', data => {
    const container = document.querySelector(`.message-reactions[data-message-id="${CSS.escape(String(data.message_id))}"]`);
    container?.querySelector('.reaction-item')?.remove();
});
socket.on('message_starred', data => document.querySelector(`[data-message-id="${CSS.escape(String(data.message_id))}"]`)?.classList.toggle('starred', data.starred));

toggleReaction = function (messageId, emoji) {
    const item = document.querySelector(`.message-reactions[data-message-id="${CSS.escape(String(messageId))}"] .reaction-item`);
    socket.emit(item ? 'remove_reaction' : 'add_reaction', { message_id: messageId, user: username, emoji });
};

editMessage = function (messageId) {
    const text = document.querySelector(`[data-message-id="${messageId}"] .message-text`)?.textContent || '';
    const next = prompt('Edit message', text);
    if (next && next.trim() && next.trim() !== text) socket.emit('edit_message', { message_id: messageId, new_text: next.trim(), editor: username });
};

socket.on('user_profile', data => {
    if (data.error) {
        showNotification(data.error);
        closeUserProfileModal();
        return;
    }

    byId('profileAvatar').src = data.avatar_url || '/static/default-avatar.svg';
    byId('profileBio').value = data.bio || 'No bio yet...';

    // Status
    const statusDiv = byId('profileStatus');
    const statusDot = statusDiv.querySelector('.status-dot');
    const statusText = statusDiv.querySelector('span:not(.status-dot)');

    if (data.is_online) {
        statusDot.style.background = '#10b981';
        statusText.textContent = 'Online';
    } else {
        statusDot.style.background = '#6b7280';
        statusText.textContent = `Last seen: ${data.last_seen || 'Unknown'}`;
    }

    // Mutual groups
    const mutualGroupsList = byId('mutualGroupsList');
    if (data.mutual_groups && data.mutual_groups.length > 0) {
        mutualGroupsList.innerHTML = data.mutual_groups.map(group =>
            `<div style="padding: 4px 0;">${group}</div>`
        ).join('');
    } else {
        mutualGroupsList.innerHTML = '<span style="color: var(--text-tertiary);">No mutual groups</span>';
    }
});

function closeUserProfileModal() {
    byId('userProfileModal').style.display = 'none';
    currentProfileUser = null;
}

function blockUser() {
    if (!currentProfileUser) return;

    if (confirm(`Are you sure you want to block ${currentProfileUser}?`)) {
        socket.emit('block_user', { username: currentProfileUser });
        showNotification(`${currentProfileUser} has been blocked`);
        closeUserProfileModal();
    }
}

// ==================== MEDIA GALLERY ====================

let currentMediaFilter = 'all';
let currentMediaRecipient = null;

function openMediaGallery() {
    if (!currentRecipient) {
        showNotification('Please select a chat first');
        return;
    }

    currentMediaRecipient = currentRecipient;
    byId('mediaGalleryModal').style.display = 'flex';

    // Request media
    socket.emit('get_media_gallery', {
        recipient: currentRecipient,
        is_group: currentIsGroup
    });
}

socket.on('media_gallery', data => {
    if (data.error) {
        showNotification(data.error);
        return;
    }

    displayMediaGallery(data.media);
});

function displayMediaGallery(mediaList) {
    const grid = byId('mediaGalleryGrid');

    if (!mediaList || mediaList.length === 0) {
        grid.innerHTML = '<p style="color: var(--text-tertiary); text-align: center; padding: 20px; grid-column: 1/-1;">No media found</p>';
        return;
    }

    // Filter media
    let filteredMedia = mediaList;
    if (currentMediaFilter === 'images') {
        filteredMedia = mediaList.filter(m => m.type === 'image');
    } else if (currentMediaFilter === 'videos') {
        filteredMedia = mediaList.filter(m => m.type === 'video');
    } else if (currentMediaFilter === 'files') {
        filteredMedia = mediaList.filter(m => m.type === 'file');
    }

    grid.innerHTML = filteredMedia.map(media => {
        if (media.type === 'image') {
            return `
                <div class="media-item" onclick="openLightbox('${media.url}')" style="cursor: pointer; border-radius: 8px; overflow: hidden; height: 150px;">
                    <img src="${media.url}" alt="Image" style="width: 100%; height: 100%; object-fit: cover;">
                </div>
            `;
        } else if (media.type === 'file') {
            return `
                <div class="media-item" style="background: var(--sidebar-bg); border-radius: 8px; padding: 12px; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 150px;">
                    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path>
                        <polyline points="13 2 13 9 20 9"></polyline>
                    </svg>
                    <p style="margin-top: 8px; font-size: 12px; text-align: center; word-break: break-word;">${media.filename}</p>
                    <a href="${media.url}" download style="margin-top: 8px; font-size: 11px; color: var(--primary-color);">Download</a>
                </div>
            `;
        }
        return '';
    }).join('');
}

function filterMediaGallery(filter) {
    currentMediaFilter = filter;

    // Update active button
    ['filterAll', 'filterImages', 'filterVideos', 'filterFiles'].forEach(id => {
        byId(id).classList.remove('active');
    });

    const filterMap = {
        'all': 'filterAll',
        'images': 'filterImages',
        'videos': 'filterVideos',
        'files': 'filterFiles'
    };
    byId(filterMap[filter]).classList.add('active');

    // Re-request media
    socket.emit('get_media_gallery', {
        recipient: currentMediaRecipient,
        is_group: currentIsGroup
    });
}

function closeMediaGalleryModal() {
    byId('mediaGalleryModal').style.display = 'none';
    currentMediaFilter = 'all';
}

function openLightbox(imageUrl) {
    byId('lightboxImage').src = imageUrl;
    byId('mediaLightbox').style.display = 'flex';
}

function closeLightbox() {
    byId('mediaLightbox').style.display = 'none';
    byId('lightboxImage').src = '';
}

// ==================== NOTIFICATION SETTINGS ====================

function openNotificationSettings() {
    if (!currentRecipient) {
        showNotification('Please select a chat first');
        return;
    }

    // Load saved settings
    const settings = getNotificationSettings(currentRecipient);
    byId('enableNotifications').checked = settings.enabled;
    byId('muteDuration').value = settings.muted_until;
    byId('notificationSound').value = settings.sound;
    byId('showPreview').checked = settings.show_preview;

    byId('notificationSettingsModal').style.display = 'flex';
}

function closeNotificationSettingsModal() {
    byId('notificationSettingsModal').style.display = 'none';
}

function saveNotificationSettings() {
    if (!currentRecipient) return;

    const settings = {
        enabled: byId('enableNotifications').checked,
        muted_until: parseInt(byId('muteDuration').value),
        sound: byId('notificationSound').value,
        show_preview: byId('showPreview').checked
    };

    // Calculate mute expiry
    if (settings.muted_until > 0) {
        settings.muted_expiry = Date.now() + (settings.muted_until * 1000);
    } else if (settings.muted_until === -1) {
        settings.muted_expiry = -1; // Forever
    } else {
        settings.muted_expiry = 0; // Not muted
    }

    // Save to localStorage
    const allSettings = JSON.parse(localStorage.getItem('notificationSettings') || '{}');
    allSettings[currentRecipient] = settings;
    localStorage.setItem('notificationSettings', JSON.stringify(allSettings));

    showNotification('Notification settings saved');
    closeNotificationSettingsModal();
}

function getNotificationSettings(recipient) {
    const allSettings = JSON.parse(localStorage.getItem('notificationSettings') || '{}');
    const settings = allSettings[recipient] || {
        enabled: true,
        muted_until: 0,
        muted_expiry: 0,
        sound: 'default',
        show_preview: true
    };

    // Check if mute has expired
    if (settings.muted_expiry > 0 && settings.muted_expiry < Date.now()) {
        settings.muted_until = 0;
        settings.muted_expiry = 0;
    }

    return settings;
}

function isNotificationMuted(recipient) {
    const settings = getNotificationSettings(recipient);
    if (!settings.enabled) return true;
    if (settings.muted_expiry === -1) return true; // Forever
    if (settings.muted_expiry > Date.now()) return true;
    return false;
}

// ==================== MESSAGE PINNING ====================

let pinnedMessages = {};

function togglePinMessage(messageId) {
    if (!currentRecipient) return;

    const chatKey = currentRecipient;
    const currentIsGroup = allGroups.some(group => group.name === currentRecipient);
    const pinned = pinnedMessages[chatKey] || [];

    if (pinned.includes(messageId)) {
        // Unpin
        socket.emit('unpin_message', {
            message_id: messageId,
            recipient: currentRecipient,
            is_group: currentIsGroup
        });
    } else {
        // Pin (max 3)
        if (pinned.length >= 3) {
            showNotification('Maximum 3 pinned messages per chat');
            return;
        }
        socket.emit('pin_message', {
            message_id: messageId,
            recipient: currentRecipient,
            is_group: currentIsGroup
        });
    }
}

socket.on('message_pinned', data => {
    const chatKey = data.chat_id;
    if (!pinnedMessages[chatKey]) pinnedMessages[chatKey] = [];

    if (!pinnedMessages[chatKey].includes(data.message_id)) {
        pinnedMessages[chatKey].push(data.message_id);
    }

    updatePinnedBanner();

    // Add visual indicator to message
    const messageEl = document.querySelector(`[data-message-id="${data.message_id}"]`);
    if (messageEl) {
        messageEl.classList.add('pinned');
    }

    showNotification('Message pinned');
});

socket.on('message_unpinned', data => {
    const chatKey = data.chat_id;
    if (pinnedMessages[chatKey]) {
        pinnedMessages[chatKey] = pinnedMessages[chatKey].filter(id => id !== data.message_id);
    }

    updatePinnedBanner();

    // Remove visual indicator
    const messageEl = document.querySelector(`[data-message-id="${data.message_id}"]`);
    if (messageEl) {
        messageEl.classList.remove('pinned');
    }

    showNotification('Message unpinned');
});

socket.on('pinned_messages', data => {
    pinnedMessages[data.chat_id] = data.pinned_ids;
    updatePinnedBanner();

    // Add indicators to messages
    data.pinned_ids.forEach(id => {
        const messageEl = document.querySelector(`[data-message-id="${id}"]`);
        if (messageEl) {
            messageEl.classList.add('pinned');
        }
    });
});

function updatePinnedBanner() {
    const chatKey = currentRecipient;
    const pinned = pinnedMessages[chatKey] || [];

    let banner = byId('pinnedMessagesBanner');
    if (!banner && pinned.length > 0) {
        // Create banner
        banner = document.createElement('div');
        banner.id = 'pinnedMessagesBanner';
        banner.className = 'pinned-messages-banner';
        byId('messages').insertBefore(banner, byId('messages').firstChild);
    }

    if (pinned.length === 0) {
        if (banner) banner.remove();
        return;
    }

    banner.innerHTML = `
        <div style="display: flex; align-items: center; gap: 8px;">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 17v5"></path>
                <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"></path>
            </svg>
            <span>${pinned.length} pinned message${pinned.length > 1 ? 's' : ''}</span>
        </div>
        <button onclick="scrollToFirstPinned()" style="background: none; border: none; color: var(--primary-color); cursor: pointer; padding: 4px 8px;">View</button>
    `;
}

function scrollToFirstPinned() {
    const chatKey = currentRecipient;
    const pinned = pinnedMessages[chatKey] || [];

    if (pinned.length > 0) {
        const firstPinned = document.querySelector(`[data-message-id="${pinned[0]}"]`);
        if (firstPinned) {
            firstPinned.scrollIntoView({ behavior: 'smooth', block: 'center' });
            firstPinned.style.backgroundColor = 'var(--primary-color)';
            setTimeout(() => {
                firstPinned.style.backgroundColor = '';
            }, 1000);
        }
    }
}

// Update showMessageOptions to include pin option
const originalShowMessageOptions = showMessageOptions;
showMessageOptions = function (messageId, messageText) {
    // Call original function (if it exists)
    if (typeof originalShowMessageOptions === 'function') {
        originalShowMessageOptions(messageId, messageText);
    }

    // Add pin option to context menu
    const menu = document.querySelector('.message-options-menu');
    if (menu) {
        const chatKey = currentRecipient;
        const pinned = pinnedMessages[chatKey] || [];
        const isPinned = pinned.includes(messageId);

        const pinOption = document.createElement('div');
        pinOption.className = 'message-option';
        pinOption.textContent = isPinned ? '📌 Unpin' : '📌 Pin';
        pinOption.onclick = () => {
            togglePinMessage(messageId);
            menu.remove();
        };

        menu.insertBefore(pinOption, menu.firstChild);
    }
};

// Handle auto-login after QR scan
socket.on('paired_user_info', data => {
    if (data.username) {
        // Auto-login the user
        username = data.username;
        startChatSession(username);
    }
});

// ==================== MOBILE KEYBOARD / AUTO-SCROLL HELPERS ====================
// Ensure messages scroll to bottom when input is focused or when the mobile keyboard opens
function scrollMessagesToBottom(smooth = false) {
    const el = byId('messages');
    if (!el) return;
    try {
        if (smooth) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
        else el.scrollTop = el.scrollHeight;
    } catch (e) {
        el.scrollTop = el.scrollHeight;
    }
}

// VisualViewport helps detect keyboard opening on modern mobile browsers
let lastViewportHeight = (window.visualViewport && window.visualViewport.height) || window.innerHeight;
function handleViewportResize() {
    const vh = (window.visualViewport && window.visualViewport.height) || window.innerHeight;
    // If viewport height decreased substantially, likely keyboard opened — scroll to bottom
    if (vh < lastViewportHeight - 80) {
        setTimeout(() => scrollMessagesToBottom(true), 120);
    }
    lastViewportHeight = vh;
}

document.addEventListener('DOMContentLoaded', () => {
    const input = byId('messageInput');
    if (input) {
        input.addEventListener('focus', () => {
            setTimeout(() => scrollMessagesToBottom(true), 200);
        });
        input.addEventListener('blur', () => {
            // optional: adjust viewport after blur
            setTimeout(() => scrollMessagesToBottom(false), 150);
        });
    }

    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', handleViewportResize);
    } else {
        // Fallback for browsers that don't support visualViewport
        window.addEventListener('resize', handleViewportResize);
    }

    // Also ensure we scroll to bottom when new messages arrive (safety net)
    const messagesEl = byId('messages');
    if (messagesEl) {
        const observer = new MutationObserver((mutations) => {
            for (const m of mutations) {
                if (m.addedNodes && m.addedNodes.length) {
                    // Auto-scroll if input is focused or near bottom
                    const inputFocused = document.activeElement === input;
                    const atBottom = isMessagesAtBottom();
                    if (inputFocused || atBottom) scrollMessagesToBottom(true);
                    break;
                }
            }
        });
        observer.observe(messagesEl, { childList: true, subtree: false });
    }
});

// ==================== Premium UX states ====================
function setConnectionState(state, detail = '') {
    const banner = byId('connectionRecovery');
    if (!banner) return;
    if (state === 'connected') { banner.className = 'connection-recovery'; banner.textContent = ''; return; }
    banner.className = `connection-recovery visible ${state === 'offline' ? 'offline' : ''}`;
    banner.textContent = detail || (state === 'offline' ? 'Offline · messages will retry when connected' : 'Reconnecting…');
}
socket.on('connect', () => setConnectionState('connected'));
socket.on('disconnect', () => setConnectionState('offline'));
socket.on('connect_error', () => setConnectionState('reconnecting'));
socket.on('reconnect_attempt', () => setConnectionState('reconnecting'));
socket.on('reconnect', () => setConnectionState('connected'));

function showUserSkeletons() {
    const list = byId('userList');
    if (list) list.innerHTML = '<li class="skeleton-row" aria-label="Loading conversations"></li><li class="skeleton-row"></li><li class="skeleton-row"></li>';
}
function showMessageSkeletons() {
    const messages = byId('messages');
    if (messages) messages.innerHTML = '<div class="skeleton-message"></div><div class="skeleton-message mine"></div><div class="skeleton-message"></div>';
}
function showMediaSkeletons() {
    const grid = byId('mediaGalleryGrid');
    if (grid) grid.innerHTML = '<div class="skeleton-media"></div><div class="skeleton-media"></div><div class="skeleton-media"></div>';
}

const bb84OriginalSelectUser = selectUser;
selectUser = function (user, element) {
    bb84OriginalSelectUser(user, element);
    showMessageSkeletons();
};
const bb84OriginalSelectGroup = selectGroup;
selectGroup = function (group, element) {
    bb84OriginalSelectGroup(group, element);
    showMessageSkeletons();
};

const bb84OriginalOpenMediaGallery = openMediaGallery;
openMediaGallery = function () { showMediaSkeletons(); bb84OriginalOpenMediaGallery(); };

const bb84OriginalShowNewMessagesIndicator = showNewMessagesIndicator;
showNewMessagesIndicator = function () {
    bb84OriginalShowNewMessagesIndicator();
    byId('jumpToLatest')?.classList.add('visible');
    if (!byId('messages')?.querySelector('.unread-separator')) {
        const separator = document.createElement('div');
        separator.className = 'unread-separator';
        separator.textContent = 'New messages';
        byId('messages')?.appendChild(separator);
    }
};
const bb84OriginalHideNewMessagesIndicator = hideNewMessagesIndicator;
hideNewMessagesIndicator = function () { bb84OriginalHideNewMessagesIndicator(); byId('jumpToLatest')?.classList.remove('visible'); byId('messages')?.querySelector('.unread-separator')?.remove(); };

function openPinnedPanel() {
    const existing = byId('pinnedStarredPanel');
    if (existing) { existing.remove(); return; }
    const panel = document.createElement('aside');
    panel.id = 'pinnedStarredPanel';
    panel.className = 'pinned-starred-panel';
    const messages = [...document.querySelectorAll('#messages .message')].filter(message => message.classList.contains('pinned') || message.classList.contains('starred'));
    panel.innerHTML = '<h3>Pinned & starred</h3>';
    if (!messages.length) panel.innerHTML += '<div class="pinned-starred-item">Nothing saved in this conversation yet.</div>';
    messages.forEach(message => {
        const item = document.createElement('div'); item.className = 'pinned-starred-item';
        item.textContent = `${message.classList.contains('pinned') ? '📌' : '★'} ${message.querySelector('.message-text')?.textContent || 'Media message'}`;
        item.onclick = () => { message.scrollIntoView({behavior:'smooth', block:'center'}); panel.remove(); };
        panel.appendChild(item);
    });
    byId('chat-window')?.appendChild(panel);
}

function addUnreadSeparator() {
    const messages = byId('messages');
    if (!messages || messages.querySelector('.unread-separator')) return;
    const separator = document.createElement('div'); separator.className = 'unread-separator'; separator.textContent = 'New messages'; messages.appendChild(separator);
}

document.addEventListener('DOMContentLoaded', () => {
    if (!username) showUserSkeletons();
    const messages = byId('messages');
    const jump = byId('jumpToLatest');
    const overlay = byId('chatDropOverlay');
    if (jump) jump.onclick = () => { messages.scrollTo({top: messages.scrollHeight, behavior: 'smooth'}); hideNewMessagesIndicator(); };
    if (messages) messages.addEventListener('scroll', () => { if (isMessagesAtBottom()) hideNewMessagesIndicator(); });
    const chatWindow = byId('chat-window');
    if (chatWindow && overlay) {
        let dragDepth = 0;
        chatWindow.addEventListener('dragenter', event => { event.preventDefault(); dragDepth++; overlay.classList.add('active'); });
        chatWindow.addEventListener('dragleave', event => { event.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; overlay.classList.remove('active'); } });
        chatWindow.addEventListener('dragover', event => event.preventDefault());
        chatWindow.addEventListener('drop', event => { event.preventDefault(); dragDepth = 0; overlay.classList.remove('active'); [...(event.dataTransfer?.files || [])].forEach(uploadFileWithProgress); });
    }
});

socket.on('chat_history', () => { byId('messages')?.querySelectorAll('.skeleton-message').forEach(el => el.remove()); });
socket.on('group_history', () => { byId('messages')?.querySelectorAll('.skeleton-message').forEach(el => el.remove()); });

const bb84AppendWithPremiumUX = appendMessage;
appendMessage = function (sender, message, data = {}) {
    bb84AppendWithPremiumUX(sender, message, data);
    const id = String(data.id || '');
    const messageDiv = [...document.querySelectorAll('#messages .message')].find(el => el.dataset.messageId === id) || document.querySelector('#messages .message:last-of-type');
    if (!messageDiv || !data.file_url) return;
    if (data.message_type === 'video' || /\.(mp4|webm|mov)(\?|$)/i.test(data.file_url)) {
        const old = messageDiv.querySelector('.message-file');
        const video = document.createElement('video');
        video.className = 'message-video'; video.controls = true; video.preload = 'metadata'; video.src = data.file_url;
        if (old) old.replaceWith(video); else messageDiv.querySelector('.message-bubble')?.appendChild(video);
    }
    const image = messageDiv.querySelector('.message-image');
    if (image) image.onclick = () => typeof openLightbox === 'function' ? openLightbox(data.file_url) : window.open(data.file_url, '_blank');
};

function setActivityStatus(text, timeout = 0) {
    const status = byId('activityStatus');
    if (!status) return;
    status.textContent = text || '';
    if (timeout) setTimeout(() => { if (status.textContent === text) status.textContent = ''; }, timeout);
}

const bb84UploadWithStatus = uploadFileWithProgress;
uploadFileWithProgress = async function (file) {
    if (file) setActivityStatus(`Uploading ${file.name}…`);
    try { await bb84UploadWithStatus(file); setActivityStatus('Upload complete', 1800); }
    catch (error) { setActivityStatus('Upload failed · try again', 3500); throw error; }
};

const bb84OriginalStartRecording = startRecording;
startRecording = async function () { setActivityStatus('Recording voice message…'); await bb84OriginalStartRecording(); };
const bb84OriginalStopRecording = stopRecording;
stopRecording = function () { bb84OriginalStopRecording(); setActivityStatus('Voice message ready', 1800); };

socket.on('error', data => setActivityStatus(data?.message || 'Something went wrong', 3500));
socket.on('session_expired', () => { setConnectionState('offline', 'Session expired · sign in again'); showNotification('Your session expired. Please sign in again.'); });
