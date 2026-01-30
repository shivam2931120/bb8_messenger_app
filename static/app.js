// ==================== SOCKET & STATE ====================
const socket = io({ transports: ['polling'], upgrade: false });
let username = null;
let currentRecipient = null;
const sharedKeys = {};
let typingTimeout = null;
let currentMessageId = null;
const userStatuses = {};

// ==================== HELPER FUNCTIONS ====================
const byId = id => document.getElementById(id);

function showNotification(message) {
    const notif = byId('notification');
    byId('notificationText').textContent = message;
    notif.classList.add('show');
    setTimeout(() => notif.classList.remove('show'), 3000);

    // Browser notification if permission granted
    if (Notification.permission === 'granted') {
        new Notification('BB84 Chat', { body: message, icon: '/static/icon.png' });
    }
}

function requestNotificationPermission() {
    if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission();
    }
}

// ==================== AUTH ====================
function toggleAuth(mode) {
    byId('login-box').style.display = mode === 'login' ? 'block' : 'none';
    byId('register-box').style.display = mode === 'register' ? 'block' : 'none';
    byId('login-error').style.display = 'none';
    byId('register-error').style.display = 'none';
}

async function performAuth(endpoint, user, pass, errorEl) {
    if (!user || !pass) {
        errorEl.textContent = 'Please fill in all fields';
        errorEl.style.display = 'block';
        return;
    }

    try {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: user, password: pass })
        });
        const data = await response.json();

        if (data.success) {
            startChatSession(user);
            requestNotificationPermission();
        } else {
            errorEl.textContent = data.error || 'Authentication failed';
            errorEl.style.display = 'block';
        }
    } catch (error) {
        errorEl.textContent = 'Connection error. Please try again.';
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
        byId('register-error')
    );
}

function startChatSession(user) {
    username = user;
    byId('auth-screen').style.display = 'none';
    byId('chat-screen').style.display = 'flex';
    socket.emit("register_user", username);
    socket.emit("update_status", { username, status: "online" });
}

// ==================== USER LIST ====================
function filterUsers() {
    const searchTerm = byId('userSearch').value.toLowerCase();
    const users = Array.from(byId('userList').children);
    users.forEach(li => {
        const userName = li.textContent.toLowerCase();
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
    return statusMap[status] || 'status-offline';
}

// ==================== MESSAGES ====================
function appendMessage(sender, message, data = {}) {
    const msgDiv = document.createElement("div");
    msgDiv.classList.add("message");
    msgDiv.classList.add(sender === username ? "sent" : "received");
    msgDiv.dataset.messageId = data.id || Date.now();

    if (data.pinned) {
        msgDiv.classList.add("pinned");
    }

    const senderSpan = document.createElement("span");
    senderSpan.className = "sender-name";
    senderSpan.textContent = sender;

    const msgContent = document.createElement("div");
    msgContent.className = "message-content";

    // Handle different message types
    if (data.message_type === 'image' && data.file_url) {
        const img = document.createElement("img");
        img.src = data.file_url;
        img.className = "message-image";
        img.onclick = () => window.open(data.file_url, '_blank');
        msgContent.appendChild(img);
        if (message && message !== data.file_name) {
            const caption = document.createElement("p");
            caption.textContent = message;
            msgContent.appendChild(caption);
        }
    } else if (data.message_type === 'voice' && data.file_url) {
        const audioDiv = document.createElement("div");
        audioDiv.className = "message-voice";
        const audio = document.createElement("audio");
        audio.controls = true;
        audio.src = data.file_url;
        audioDiv.appendChild(audio);
        msgContent.appendChild(audioDiv);
    } else if (data.message_type === 'file' && data.file_url) {
        const fileDiv = document.createElement("div");
        fileDiv.className = "message-file";
        fileDiv.innerHTML = `
            <span>📄</span>
            <a href="${data.file_url}" download="${data.file_name}" style="color: inherit; text-decoration: none;">
                ${data.file_name || 'Download file'}
            </a>
        `;
        msgContent.appendChild(fileDiv);
    } else {
        const msgText = document.createElement("p");
        msgText.textContent = message;
        msgContent.appendChild(msgText);
    }

    // Timestamp
    if (data.timestamp) {
        const timestamp = document.createElement("span");
        timestamp.className = "message-timestamp";
        timestamp.textContent = new Date(data.timestamp).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit'
        });
        msgContent.appendChild(timestamp);
    }

    // Message actions
    const actions = document.createElement("div");
    actions.className = "message-actions";
    actions.innerHTML = `
        <button class="message-action-btn" onclick="openReactionPicker(${data.id || msgDiv.dataset.messageId})" title="React">😊</button>
        <button class="message-action-btn" onclick="pinMessage(${data.id || msgDiv.dataset.messageId})" title="Pin">📌</button>
        <button class="message-action-btn" onclick="starMessage(${data.id || msgDiv.dataset.messageId})" title="Star">⭐</button>
    `;

    // Reactions
    const reactionsDiv = document.createElement("div");
    reactionsDiv.className = "message-reactions";
    reactionsDiv.dataset.messageId = data.id || msgDiv.dataset.messageId;

    if (data.reactions && data.reactions.length > 0) {
        renderReactions(reactionsDiv, data.reactions);
    }

    msgDiv.appendChild(senderSpan);
    msgDiv.appendChild(msgContent);
    msgDiv.appendChild(actions);
    msgDiv.appendChild(reactionsDiv);

    byId('messages').appendChild(msgDiv);
    byId('messages').scrollTop = byId('messages').scrollHeight;
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
        reactionItem.innerHTML = `${emoji} <span class="reaction-count">${data.count}</span>`;
        reactionItem.title = data.users.join(', ');
        reactionItem.onclick = () => toggleReaction(container.dataset.messageId, emoji);
        container.appendChild(reactionItem);
    });
}

function showTypingIndicator(sender) {
    // Remove existing typing indicators
    const existing = document.querySelector('.typing-indicator');
    if (existing) existing.remove();

    const indicator = document.createElement("div");
    indicator.className = "typing-indicator";
    indicator.dataset.sender = sender;
    indicator.innerHTML = `
        <div class="typing-dots">
            <div class="typing-dot"></div>
            <div class="typing-dot"></div>
            <div class="typing-dot"></div>
        </div>
    `;
    byId('messages').appendChild(indicator);
    byId('messages').scrollTop = byId('messages').scrollHeight;
}

function hideTypingIndicator(sender) {
    const indicator = document.querySelector(`.typing-indicator[data-sender="${sender}"]`);
    if (indicator) indicator.remove();
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

async function handleVoiceUpload(event) {
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
            sendFileMessage(data.file_url, data.file_name, 'voice');
        } else {
            showNotification('Voice upload failed: ' + data.error);
        }
    } catch (error) {
        showNotification('Voice upload error');
    }

    event.target.value = '';
}

function sendFileMessage(fileUrl, fileName, fileType) {
    if (!currentRecipient) return;

    socket.emit("send_message", {
        sender: username,
        recipient: currentRecipient,
        message: fileName,
        message_type: fileType,
        file_url: fileUrl,
        file_name: fileName
    });
}

// ==================== SEND MESSAGE ====================
function sendMessage() {
    const input = byId('messageInput');
    const text = input.value.trim();

    if (text && currentRecipient) {
        socket.emit("send_message", {
            sender: username,
            recipient: currentRecipient,
            message: text,
            message_type: 'text'
        });
        input.value = "";
        input.style.height = 'auto';
        socket.emit("stop_typing", { sender: username, recipient: currentRecipient });
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

    // Auto-resize textarea
    input.style.height = 'auto';
    input.style.height = input.scrollHeight + 'px';

    if (!currentRecipient) return;

    // Send typing event
    socket.emit("typing", { sender: username, recipient: currentRecipient });

    // Clear previous timeout
    if (typingTimeout) {
        clearTimeout(typingTimeout);
    }

    // Stop typing after 2 seconds of inactivity
    typingTimeout = setTimeout(() => {
        socket.emit("stop_typing", { sender: username, recipient: currentRecipient });
    }, 2000);
}

// ==================== REACTIONS ====================
function openReactionPicker(messageId) {
    currentMessageId = messageId;
    const picker = byId('reactionPicker');
    picker.style.display = 'block';

    // Position picker near mouse
    const rect = event.target.getBoundingClientRect();
    picker.style.left = rect.left + 'px';
    picker.style.top = (rect.top - 60) + 'px';
}

function addReaction(emoji) {
    if (currentMessageId) {
        socket.emit("add_reaction", {
            message_id: currentMessageId,
            user: username,
            emoji: emoji
        });
    }
    byId('reactionPicker').style.display = 'none';
}

function toggleReaction(messageId, emoji) {
    socket.emit("remove_reaction", {
        message_id: messageId,
        user: username,
        emoji: emoji
    });
}

// ==================== MESSAGE ORGANIZATION ====================
function pinMessage(messageId) {
    socket.emit("pin_message", {
        message_id: messageId,
        user: username
    });
}

function starMessage(messageId) {
    socket.emit("star_message", {
        message_id: messageId,
        user: username
    });
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
    if (username) {
        socket.emit("register_user", username);
        socket.emit("update_status", { username, status: "online" });
    }
});

socket.on("disconnect", () => {
    console.log("Disconnected from server");
});

socket.on("update_users", users => {
    const userList = byId('userList');
    userList.innerHTML = "";
    let recipientIsOnline = false;

    users.forEach(u => {
        if (u === username) return;
        if (u === currentRecipient) recipientIsOnline = true;

        const li = document.createElement("li");

        const statusDot = document.createElement("span");
        statusDot.className = "user-status-dot " + getUserStatusClass(userStatuses[u] || 'online');

        const userName = document.createElement("span");
        userName.textContent = u;

        li.appendChild(statusDot);
        li.appendChild(userName);

        if (u === currentRecipient) li.classList.add('active');

        li.onclick = () => {
            if (currentRecipient === u) return;
            currentRecipient = u;

            document.querySelectorAll('#userList li').forEach(item => item.classList.remove('active'));
            li.classList.add('active');

            byId('chat-partner-name').textContent = currentRecipient;
            byId('messages').innerHTML = "";
            byId('chat-window').style.display = "flex";

            socket.emit("get_history", { user1: username, user2: currentRecipient });
            socket.emit("get_user_status", { username: u });
        };
        userList.appendChild(li);
    });

    if (!recipientIsOnline && currentRecipient) {
        currentRecipient = null;
        byId('chat-window').style.display = "none";
    }
});

socket.on("chat_history", data => {
    const { history, key } = data;
    sharedKeys[currentRecipient] = key;
    byId('messages').innerHTML = "";
    history.forEach(msg => {
        appendMessage(msg.sender, msg.message, msg);
    });
});

socket.on("history_cleared", () => {
    byId('messages').innerHTML = "";
    showNotification("Chat history cleared");
});

socket.on("receive_message", data => {
    const partner = data.sender === username ? currentRecipient : data.sender;
    if (partner && data.key) {
        sharedKeys[partner] = data.key;
    }

    if (data.sender === currentRecipient || (data.sender === username && partner === currentRecipient)) {
        appendMessage(data.sender, data.message, data);

        // Send delivered status
        if (data.sender === currentRecipient) {
            socket.emit("message_delivered", { id: data.id });
        }
    } else if (data.sender !== username) {
        // Show notification for messages from other users
        showNotification(`New message from ${data.sender}`);
    }
});

socket.on("user_typing", data => {
    if (data.sender === currentRecipient) {
        showTypingIndicator(data.sender);
    }
});

socket.on("user_stopped_typing", data => {
    hideTypingIndicator(data.sender);
});

socket.on("reaction_added", data => {
    const reactionsDiv = document.querySelector(`.message-reactions[data-message-id="${data.message_id}"]`);
    if (reactionsDiv) {
        // Refresh reactions display
        socket.emit("get_history", { user1: username, user2: currentRecipient });
    }
});

socket.on("reaction_removed", data => {
    const reactionsDiv = document.querySelector(`.message-reactions[data-message-id="${data.message_id}"]`);
    if (reactionsDiv) {
        // Refresh reactions display
        socket.emit("get_history", { user1: username, user2: currentRecipient });
    }
});

socket.on("message_pinned", data => {
    const message = document.querySelector(`[data-message-id="${data.message_id}"]`);
    if (message) {
        if (data.pinned) {
            message.classList.add("pinned");
        } else {
            message.classList.remove("pinned");
        }
    }
});

socket.on("search_results", data => {
    const resultsDiv = byId('searchResults');
    resultsDiv.innerHTML = '';

    if (data.results.length === 0) {
        resultsDiv.innerHTML = '<p style="text-align: center; color: #a0aec0; padding: 20px;">No results found</p>';
        return;
    }

    data.results.forEach(result => {
        const resultDiv = document.createElement("div");
        resultDiv.style.padding = "12px";
        resultDiv.style.borderBottom = "1px solid #e2e8f0";
        resultDiv.innerHTML = `
            <strong>${result.sender}</strong>
            <p>${result.message}</p>
            <small style="color: #718096;">${new Date(result.timestamp).toLocaleString()}</small>
        `;
        resultsDiv.appendChild(resultDiv);
    });
});

socket.on("user_status_changed", data => {
    userStatuses[data.username] = data.status;

    // Update user list status dots
    const userList = document.querySelectorAll('#userList li');
    userList.forEach(li => {
        if (li.textContent.includes(data.username)) {
            const dot = li.querySelector('.user-status-dot');
            if (dot) {
                dot.className = 'user-status-dot ' + getUserStatusClass(data.status);
            }
        }
    });

    // Update chat header if this is current recipient
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
    const statusEmoji = {
        'online': '🟢',
        'away': '🟡',
        'busy': '🔴',
        'offline': '⚫'
    };

    let statusStr = statusEmoji[data.status] + ' ' + data.status.charAt(0).toUpperCase() + data.status.slice(1);
    if (data.status_message) {
        statusStr += ' - ' + data.status_message;
    } else if (data.last_seen && data.show_last_seen && data.status === 'offline') {
        statusStr += ' - Last seen ' + new Date(data.last_seen).toLocaleString();
    }

    statusText.textContent = statusStr;
}

socket.on("privacy_settings_info", data => {
    byId('showLastSeen').checked = data.show_last_seen;
    byId('showReadReceipts').checked = data.show_read_receipts;
});

// Close modals when clicking outside
window.onclick = function (event) {
    if (event.target.classList.contains('modal')) {
        event.target.style.display = 'none';
    }
    if (!event.target.closest('#reactionPicker') && !event.target.closest('.message-action-btn')) {
        byId('reactionPicker').style.display = 'none';
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
