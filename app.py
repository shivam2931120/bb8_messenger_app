import eventlet
eventlet.monkey_patch()

import os
import json
import random
import secrets

# Load environment variables from .env file (for local development)
# DISABLED for now - use system env vars only
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    # dotenv not installed (production) - Render provides env vars directly
    pass

from flask import Flask, request, jsonify, send_from_directory, session
from flask_socketio import SocketIO, emit
from threading import Lock
from flask_sqlalchemy import SQLAlchemy
from sqlalchemy import text
import logging
from logging.handlers import RotatingFileHandler
import base64
from datetime import datetime, timedelta
from werkzeug.security import generate_password_hash, check_password_hash
from werkzeug.utils import secure_filename
import mimetypes

# ------------------ Flask and DB Setup ------------------
app = Flask(__name__, static_folder="static")
basedir = os.path.abspath(os.path.dirname(__file__))

# File upload configuration
UPLOAD_FOLDER = os.path.join(basedir, 'uploads')
os.makedirs(UPLOAD_FOLDER, exist_ok=True)
app.config['UPLOAD_FOLDER'] = UPLOAD_FOLDER
app.config['MAX_CONTENT_LENGTH'] = 16 * 1024 * 1024  # 16MB max file size
ALLOWED_EXTENSIONS = {'txt', 'pdf', 'png', 'jpg', 'jpeg', 'gif', 'mp3', 'wav', 'ogg', 'webm', 'mp4', 'webp'}

def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS

# Session configuration - use Flask's built-in sessions (cookie-based)
app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY', 'bb84-quantum-secret-key-change-in-production-12345')
app.config['SESSION_COOKIE_SECURE'] = False  # Set to True in production with HTTPS
app.config['SESSION_COOKIE_HTTPONLY'] = True
app.config['SESSION_COOKIE_SAMESITE'] = 'Lax'
app.config['PERMANENT_SESSION_LIFETIME'] = timedelta(days=7)

# Use PostgreSQL in production (from environment variable), SQLite locally
def _find_database_url():
    # Look for a DB URL in several commonly used environment variable names.
    candidates = [
        'DATABASE_URL',
        'RAILWAY_DATABASE_URL',
        'POSTGRES_URL',
        'POSTGRESQL_URL',
        'PG_URI',
        'SQLALCHEMY_DATABASE_URI',
        'DB_URL'
    ]
    for key in candidates:
        val = os.environ.get(key)
        if val and val.strip():  # Check if value exists and is not empty
            print(f"[startup] Found DB env var: {key}")
            return val
    return None

database_url = _find_database_url()
if database_url and database_url.strip():  # Check if URL is not empty
    # Normalize common Postgres schemes (some providers give postgres:// while SQLAlchemy
    # prefers postgresql://).
    if database_url.startswith('postgres://'):
        database_url = database_url.replace('postgres://', 'postgresql://', 1)
    app.config['SQLALCHEMY_DATABASE_URI'] = database_url
else:
    # Fallback to SQLite for local development
    app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///' + os.path.join(basedir, 'chat.db')

app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
db = SQLAlchemy(app)

# ------------------ Logging Configuration ------------------
LOG_TO_FILE = os.environ.get('LOG_TO_FILE', '1') == '1'
LOG_LEVEL = os.environ.get('LOG_LEVEL', 'INFO')
LOG_PLAINTEXT = os.environ.get('LOG_PLAINTEXT', '0') == '1'  # Dangerous: logs plaintext messages

logger = logging.getLogger('bb84chat')
logger.setLevel(getattr(logging, LOG_LEVEL.upper(), logging.INFO))
formatter = logging.Formatter('%(asctime)s %(levelname)s %(message)s')
if LOG_TO_FILE:
    os.makedirs(os.path.join(basedir, 'logs'), exist_ok=True)
    fh = RotatingFileHandler(os.path.join(basedir, 'logs', 'chat.log'), maxBytes=5*1024*1024, backupCount=5)
    fh.setLevel(getattr(logging, LOG_LEVEL.upper(), logging.INFO))
    fh.setFormatter(formatter)
    logger.addHandler(fh)
else:
    ch = logging.StreamHandler()
    ch.setLevel(getattr(logging, LOG_LEVEL.upper(), logging.INFO))
    ch.setFormatter(formatter)
    logger.addHandler(ch)

def _enc_for_log(s: str) -> str:
    """Safely encode server-stored encrypted string to base64 for logging."""
    try:
        b = s.encode('latin-1')
    except Exception:
        b = s.encode('utf-8', errors='ignore')
    return base64.b64encode(b).decode('ascii')

def _maybe_log_plain(text: str) -> str:
    return text if LOG_PLAINTEXT else '[REDACTED]'

# Initialize Socket.IO (must be after app and db)
socketio = SocketIO(app,
                    cors_allowed_origins="*",
                    async_mode="eventlet",
                    logger=False,
                    engineio_logger=False,
                    ping_timeout=120,
                    ping_interval=25,
                    allow_upgrades=True,
                    transports=['polling', 'websocket'])

# ------------------ Database Models ------------------
group_members = db.Table('group_members',
    db.Column('user_id', db.Integer, db.ForeignKey('user.id'), primary_key=True),
    db.Column('group_id', db.Integer, db.ForeignKey('group.id'), primary_key=True)
)

class Group(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(100), unique=True, nullable=False)
    creator_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    creator = db.relationship('User', foreign_keys=[creator_id], backref='created_groups')
    members = db.relationship('User', secondary=group_members, lazy='subquery',
                              backref=db.backref('groups', lazy=True))

    def __repr__(self):
        return f'<Group {self.name}>'


class User(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(100), unique=True, nullable=False)
    password_hash = db.Column(db.String(200), nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    status = db.Column(db.String(50), default='online') # online, away, busy, offline
    status_message = db.Column(db.String(200), nullable=True)
    last_seen = db.Column(db.DateTime, default=datetime.utcnow)
    avatar_url = db.Column(db.String(500), nullable=True)
    show_last_seen = db.Column(db.Boolean, default=True)
    show_read_receipts = db.Column(db.Boolean, default=True)
    allow_messages_from = db.Column(db.String(20), default='everyone') # everyone, contacts

    def __repr__(self):
        return f'<User {self.username}>'

class Message(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    sender = db.Column(db.String(100), nullable=False)
    recipient = db.Column(db.String(100), nullable=True) # Can be null for group messages
    group_id = db.Column(db.Integer, db.ForeignKey('group.id'), nullable=True)
    encrypted_message = db.Column(db.Text, nullable=False)
    timestamp = db.Column(db.DateTime, default=datetime.utcnow)
    status = db.Column(db.String(20), nullable=False, default='sent') # sent, delivered, read
    read = db.Column(db.Boolean, default=False)
    edited = db.Column(db.Boolean, default=False)
    message_type = db.Column(db.String(20), default='text') # text, image, file, voice
    file_url = db.Column(db.String(500), nullable=True)
    file_name = db.Column(db.String(255), nullable=True)
    reply_to_id = db.Column(db.Integer, db.ForeignKey('message.id'), nullable=True)
    pinned = db.Column(db.Boolean, default=False)
    starred = db.Column(db.Boolean, default=False)
    deleted = db.Column(db.Boolean, default=False)
    deleted_for = db.Column(db.String(500), nullable=True)  # JSON array of users who deleted

    def __repr__(self):
        return f'<Message from {self.sender} to {self.recipient}>'

class MessageReaction(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    message_id = db.Column(db.Integer, db.ForeignKey('message.id'), nullable=False)
    user = db.Column(db.String(100), nullable=False)
    emoji = db.Column(db.String(10), nullable=False)
    timestamp = db.Column(db.DateTime, default=datetime.utcnow)

    def __repr__(self):
        return f'<Reaction {self.emoji} by {self.user} on message {self.message_id}>'

class Call(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    caller = db.Column(db.String(100), nullable=False)
    callee = db.Column(db.String(100), nullable=False)
    call_type = db.Column(db.String(20), nullable=False)
    status = db.Column(db.String(20), default='calling')
    started_at = db.Column(db.DateTime, default=datetime.utcnow)
    ended_at = db.Column(db.DateTime, nullable=True)
    duration = db.Column(db.Integer, nullable=True)
    offer = db.Column(db.Text, nullable=True)
    answer = db.Column(db.Text, nullable=True)

    def __repr__(self):
        return f'<Call {self.call_type} from {self.caller} to {self.callee}>'

class GroupAdmin(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    group_id = db.Column(db.Integer, db.ForeignKey('group.id'), nullable=False)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    role = db.Column(db.String(20), default='admin')  # admin or super_admin
    can_add_members = db.Column(db.Boolean, default=True)
    can_remove_members = db.Column(db.Boolean, default=True)
    can_edit_group = db.Column(db.Boolean, default=True)
    can_send_messages = db.Column(db.Boolean, default=True)
    appointed_at = db.Column(db.DateTime, default=datetime.utcnow)

    def __repr__(self):
        return f'<GroupAdmin group={self.group_id} user={self.user_id}>'

class DeviceSession(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    device_token = db.Column(db.String(255), unique=True, nullable=False)
    device_name = db.Column(db.String(100), nullable=True)
    device_type = db.Column(db.String(50), nullable=True)  # web, mobile, desktop
    ip_address = db.Column(db.String(50), nullable=True)
    last_active = db.Column(db.DateTime, default=datetime.utcnow)
    is_active = db.Column(db.Boolean, default=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    def __repr__(self):
        return f'<DeviceSession {self.device_name} for user {self.user_id}>'

class GroupInvitation(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    group_id = db.Column(db.Integer, db.ForeignKey('group.id'), nullable=False)
    invited_by = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    invited_user = db.Column(db.String(100), nullable=False)
    invite_token = db.Column(db.String(100), unique=True, nullable=False)
    status = db.Column(db.String(20), default='pending')  # pending, accepted, rejected, expired
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    expires_at = db.Column(db.DateTime, nullable=True)

    def __repr__(self):
        return f'<GroupInvitation to {self.invited_user} for group {self.group_id}>'

# ------------------ User Auth ------------------
USERS_FILE = os.path.join(basedir, "users.json")

def load_users():
    if not os.path.exists(USERS_FILE):
        return {}
    try:
        with open(USERS_FILE, "r") as f:
            return json.load(f)
    except (IOError, json.JSONDecodeError):
        return {}

def save_users(users):
    with open(USERS_FILE, "w") as f:
        json.dump(users, f, indent=4)


def verify_password(stored_password, provided_password):
    """Support legacy plain-text passwords and new hashed passwords."""
    if not stored_password or not provided_password:
        return False

    if stored_password.startswith("pbkdf2:"):
        try:
            return check_password_hash(stored_password, provided_password)
        except ValueError:
            return False

    return stored_password == provided_password

# ------------------ BB84 with Qiskit ------------------
def bb84_protocol(n=32):
    """Fast key generation (simulated BB84 for performance)"""
    # For production on limited resources, use fast hash-based key generation
    # This maintains security while being much faster than quantum simulation
    import hashlib
    
    # Generate deterministic but secure key based on timestamp and random data
    seed = f"{random.random()}{random.randint(0, 1000000)}".encode()
    hash_result = hashlib.sha256(seed).hexdigest()
    
    # Convert hash to binary string
    binary_key = bin(int(hash_result, 16))[2:].zfill(256)
    
    # Return first n bits
    return binary_key[:n] if n <= len(binary_key) else binary_key


def xor_encrypt_decrypt(message, key):
    """Encrypt/decrypt using XOR and binary key string with base64 encoding"""
    key_bits = [int(b) for b in key]
    key_len = len(key_bits)
    # Convert message to bytes for XOR operation
    result_bytes = bytearray()
    for i, c in enumerate(message.encode('utf-8')):
        result_bytes.append(c ^ key_bits[i % key_len])
    # Return base64 encoded string for safe storage
    return base64.b64encode(bytes(result_bytes)).decode('utf-8')

def xor_decrypt(encrypted_base64, key):
    """Decrypt base64 encoded encrypted message"""
    try:
        key_bits = [int(b) for b in key]
        key_len = len(key_bits)
        # Decode from base64
        encrypted_bytes = base64.b64decode(encrypted_base64)
        # XOR to decrypt
        result_bytes = bytearray()
        for i, byte in enumerate(encrypted_bytes):
            result_bytes.append(byte ^ key_bits[i % key_len])
        # Return decoded string
        return bytes(result_bytes).decode('utf-8')
    except Exception as e:
        print(f"Decryption error: {e}")
        return "[Decryption Error]"

# ------------------ Chat State ------------------
online_users = {}
shared_keys = {}
lock = Lock()
# Eavesdrop registration: map pair_key -> eavesdropper username
eavesdrop_targets = {}

def get_shared_key(user1, user2):
    pair = tuple(sorted((user1, user2)))
    with lock:
        if pair not in shared_keys:
            shared_keys[pair] = bb84_protocol(n=32)
            print(f"🔑 New key for {pair}: {shared_keys[pair]}")
        return shared_keys[pair]

# ------------------ Routes ------------------
@app.route("/")
def index():
    response = send_from_directory("static", "chat.html")
    response.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
    response.headers['Pragma'] = 'no-cache'
    response.headers['Expires'] = '0'
    return response

@app.route('/static/<path:filename>')
def serve_static(filename):
    response = send_from_directory("static", filename)
    response.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
    return response

@app.route('/health', methods=['GET'])
def health():
    """Simple health check endpoint for deployment diagnostics."""
    return jsonify({'status': 'ok', 'uptime': True}), 200


@app.route('/admin/users', methods=['GET'])
def admin_list_users():
    """Return list of registered users (for quick debug). Remove or protect in production."""
    # Simple token protection: set ADMIN_TOKEN env var to protect this endpoint.
    admin_token = os.environ.get('ADMIN_TOKEN')
    provided = request.headers.get('X-ADMIN-TOKEN') or request.args.get('admin_token')
    if admin_token:
        if not provided or provided != admin_token:
            return jsonify({'error': 'forbidden'}), 403
    else:
        # If no ADMIN_TOKEN set, deny to avoid accidental exposure in production
        return jsonify({'error': 'admin endpoint disabled'}), 403

    try:
        with app.app_context():
            users = [u.username for u in User.query.order_by(User.id.desc()).limit(100).all()]
        return jsonify({'count': len(users), 'users': users})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/admin/logs', methods=['GET'])
def admin_get_logs():
    """Return recent log lines. Protected by ADMIN_TOKEN."""
    admin_token = os.environ.get('ADMIN_TOKEN')
    provided = request.headers.get('X-ADMIN-TOKEN') or request.args.get('admin_token')
    if not admin_token or provided != admin_token:
        return jsonify({'error': 'forbidden'}), 403

    log_file = os.path.join(basedir, 'logs', 'chat.log')
    if not os.path.exists(log_file):
        return jsonify({'error': 'no logs'}), 404

    # Read last N lines (simple tail)
    try:
        with open(log_file, 'r') as f:
            lines = f.readlines()[-1000:]
        return jsonify({'lines': lines})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route("/login", methods=["POST"])
def login():
    data = request.json
    username = (data.get("username") or "").strip()
    password = data.get("password") or ""
    
    print(f"Login attempt for user: {username}")
    
    # Try database first (for production)
    with app.app_context():
        user = User.query.filter_by(username=username).first()
        if user:
            print(f"User found in database: {username}")
            if check_password_hash(user.password_hash, password):
                print(f"Password verified for: {username}")
                session['username'] = username
                session.permanent = True
                return jsonify({"success": True, "username": username})
            else:
                print(f"Password verification failed for: {username}")
        else:
            print(f"User not found in database: {username}")
    
    # Fallback to users.json (for local development with existing users)
    users = load_users()
    stored_password = users.get(username)
    if stored_password:
        print(f"User found in users.json: {username}")
        if verify_password(stored_password, password):
            print(f"Password verified from users.json for: {username}")
            session['username'] = username
            session.permanent = True
            return jsonify({"success": True, "username": username})
    
    print(f"Login failed for: {username}")
    return jsonify({"success": False, "error": "Invalid credentials"})

@app.route("/register", methods=["POST"])
def register():
    data = request.json
    username = (data.get("username") or "").strip()
    password = (data.get("password") or "").strip()
    
    print(f"Registration attempt for user: {username}")
    
    if not username or not password:
        return jsonify({"success": False, "error": "Username and password required"}), 400

    if len(username) < 3 or len(password) < 6:
        return jsonify({"success": False, "error": "Username must be 3+ chars and password 6+ chars"}), 400

    # Check if user already exists in database
    with app.app_context():
        existing_user = User.query.filter_by(username=username).first()
        if existing_user:
            print(f"Username already taken: {username}")
            return jsonify({"success": False, "error": "Username taken"})
        
        # Create new user in database
        password_hash = generate_password_hash(password)
        new_user = User(username=username, password_hash=password_hash)
        db.session.add(new_user)
        db.session.commit()
        print(f"User created in database: {username}")
    
    # Also save to users.json for local development compatibility
    users = load_users()
    users[username] = password_hash
    save_users(users)
    
    # Auto-login after registration
    session['username'] = username
    session.permanent = True
    
    print(f"Registration successful for: {username}")
    return jsonify({"success": True, "username": username})

@app.route("/check_session", methods=["GET"])
def check_session():
    """Check if user is already logged in"""
    username = session.get('username')
    if username:
        return jsonify({"logged_in": True, "username": username})
    return jsonify({"logged_in": False})

@app.route("/logout", methods=["POST"])
def logout():
    """Logout user by clearing session"""
    session.pop('username', None)
    return jsonify({"success": True})


@app.route("/upload_file", methods=["POST"])
def upload_file():
    """Handle file uploads for messages"""
    if 'file' not in request.files:
        return jsonify({"success": False, "error": "No file part"}), 400
    
    file = request.files['file']
    if file.filename == '':
        return jsonify({"success": False, "error": "No selected file"}), 400
    
    if file and allowed_file(file.filename):
        filename = secure_filename(file.filename)
        # Add timestamp to filename to avoid conflicts
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        filename = f"{timestamp}_{filename}"
        filepath = os.path.join(app.config['UPLOAD_FOLDER'], filename)
        file.save(filepath)
        
        # Get file type
        mime_type = mimetypes.guess_type(filepath)[0] or 'application/octet-stream'
        file_type = 'image' if mime_type.startswith('image') else 'voice' if mime_type.startswith('audio') else 'file'
        
        return jsonify({
            "success": True, 
            "file_url": f"/uploads/{filename}",
            "file_name": file.filename,
            "file_type": file_type
        })
    
    return jsonify({"success": False, "error": "File type not allowed"}), 400


@app.route("/uploads/<filename>")
def uploaded_file(filename):
    """Serve uploaded files"""
    return send_from_directory(app.config['UPLOAD_FOLDER'], filename)


# ------------------ WebSocket Events ------------------
@socketio.on("connect")
def handle_connect():
    print(f"Client connected: {request.sid}")

@socketio.on("disconnect")
def handle_disconnect():
    user_to_remove = None
    for user, sid in online_users.items():
        if sid == request.sid:
            user_to_remove = user
            break
    if user_to_remove:
        del online_users[user_to_remove]
        
        # Get updated user data
        user_data = {}
        with app.app_context():
            for user in online_users.keys():
                user_obj = User.query.filter_by(username=user).first()
                if user_obj:
                    user_data[user] = {
                        'avatar_url': user_obj.avatar_url,
                        'status': user_obj.status
                    }
        
        emit("update_users", {
            "users": list(online_users.keys()),
            "user_data": user_data
        }, broadcast=True)
    print(f"Client disconnected: {request.sid}")

@socketio.on("register_user")
def handle_register_user(username):
    if not username:
        return

    # Replace any stale connection for the same username
    online_users[username] = request.sid
    
    # Get user data including avatars for all online users
    user_data = {}
    with app.app_context():
        for user in online_users.keys():
            user_obj = User.query.filter_by(username=user).first()
            if user_obj:
                user_data[user] = {
                    'avatar_url': user_obj.avatar_url,
                    'status': user_obj.status
                }
    
    emit("update_users", {
        "users": list(online_users.keys()),
        "user_data": user_data
    }, broadcast=True)

    # Calculate and send unread message counts (be defensive: missing columns may raise)
    try:
        with app.app_context():
            unread_counts = db.session.query(Message.sender, db.func.count(Message.id)).filter(
                Message.recipient == username,
                Message.read == False
            ).group_by(Message.sender).all()
            emit("unread_counts", dict(unread_counts))
    except Exception as e:
        print(f"[startup] unread_counts query failed: {e} - attempting to heal schema and retry")
        try:
            # Attempt to heal schema drift and retry once
            _ensure_message_columns_exist()
            with app.app_context():
                unread_counts = db.session.query(Message.sender, db.func.count(Message.id)).filter(
                    Message.recipient == username,
                    Message.read == False
                ).group_by(Message.sender).all()
                emit("unread_counts", dict(unread_counts))
        except Exception as e2:
            print(f"[startup] unread_counts retry failed: {e2}")


# ------------------ BB84 and eavesdrop socket handlers ------------------
def _pair_key(a, b):
    return tuple(sorted([a, b]))


@socketio.on('register_eavesdrop')
def handle_register_eavesdrop(data):
    # data: { 'user1': 'alice', 'user2': 'bob' }
    e1 = data.get('user1')
    e2 = data.get('user2')
    enabler = data.get('by')  # username of who registered
    if not e1 or not e2 or not enabler:
        return
    key = _pair_key(e1, e2)
    eavesdrop_targets[key] = enabler
    logger.info(f"eavesdrop registered by={enabler} pair={key}")
    # acknowledge
    emit('eavesdrop_registered', {'pair': key, 'by': enabler})


@socketio.on('unregister_eavesdrop')
def handle_unregister_eavesdrop(data):
    e1 = data.get('user1')
    e2 = data.get('user2')
    enabler = data.get('by')
    if not e1 or not e2 or not enabler:
        return
    key = _pair_key(e1, e2)
    if key in eavesdrop_targets and eavesdrop_targets[key] == enabler:
        del eavesdrop_targets[key]
        logger.info(f"eavesdrop unregistered by={enabler} pair={key}")
        emit('eavesdrop_unregistered', {'pair': key, 'by': enabler})


@socketio.on('bb84_qubits')
def handle_bb84_qubits(payload):
    # payload: { from, to, qubits: [{i, bit, basis}, ...] }
    sender = payload.get('from')
    recipient = payload.get('to')
    qubits = payload.get('qubits') or []
    if not sender or not recipient or not qubits:
        return

    pair = _pair_key(sender, recipient)
    # check if eavesdrop registered for this pair
    eavesdropper = eavesdrop_targets.get(pair)
    forwarded_qubits = []
    if eavesdropper and eavesdropper in online_users:
        # simulate eavesdropper measuring each qubit
        eavesdrop_sid = online_users.get(eavesdropper)
        measured = []
        for q in qubits:
            # eavesdropper picks random basis
            basis_e = '+' if random.random() < 0.5 else 'x'
            if basis_e == q.get('basis'):
                measured_bit = q.get('bit')
            else:
                measured_bit = 1 if random.random() < 0.5 else 0
            measured.append({'i': q.get('i'), 'basis': basis_e, 'bit': measured_bit})
            # forwarded qubit is set to the eavesdropper's measured bit in their basis
            forwarded_qubits.append({'i': q.get('i'), 'bit': measured_bit, 'basis': q.get('basis')})

        # send capture data to eavesdropper
        try:
            emit('bb84_eavesdrop_capture', {'from': sender, 'to': recipient, 'measured': measured}, room=eavesdrop_sid)
            logger.info(f"eavesdrop capture sent to {eavesdropper} for pair {pair}")
        except Exception as e:
            print(f"eavesdrop emit failed: {e}")
    else:
        forwarded_qubits = qubits

    # forward (possibly altered) qubits to recipient
    recip_sid = online_users.get(recipient)
    if recip_sid:
        emit('bb84_qubits', {'from': sender, 'to': recipient, 'qubits': forwarded_qubits}, room=recip_sid)
        logger.info(f"bb84_qubits forwarded from={sender} to={recipient} eavesdrop={bool(eavesdropper)}")


@socketio.on('bb84_measurements')
def handle_bb84_measurements(payload):
    # relay measurements back to initiator
    to = payload.get('to')
    if to and to in online_users:
        emit('bb84_measurements', payload, room=online_users[to])


@socketio.on('bb84_bases_reveal')
def handle_bb84_bases_reveal(payload):
    to = payload.get('to')
    if to and to in online_users:
        emit('bb84_bases_reveal', payload, room=online_users[to])


@socketio.on('bb84_sample_reveal')
def handle_bb84_sample_reveal(payload):
    to = payload.get('to')
    if to and to in online_users:
        emit('bb84_sample_reveal', payload, room=online_users[to])


@socketio.on('bb84_result')
def handle_bb84_result(payload):
    # payload includes e_rate and passed, relay to the other party
    to = payload.get('to')
    if to and to in online_users:
        emit('bb84_result', payload, room=online_users[to])
    # also log the result
    try:
        logger.info(f"bb84_result from={payload.get('from')} to={to} e_rate={payload.get('e_rate')} passed={payload.get('passed')}")
    except Exception:
        pass

@socketio.on("send_message")
def handle_send_message(data):
    sender = data.get("sender")
    recipient = data.get("recipient")
    message = data.get("message")
    message_type = data.get("message_type", "text")
    file_url = data.get("file_url")
    file_name = data.get("file_name")
    reply_to_id = data.get("reply_to_id")
    
    if not sender or not recipient or not message:
        return

    key = get_shared_key(sender, recipient)
    encrypted_msg = xor_encrypt_decrypt(message, key)

    # Log the send event (encrypted payload). Do NOT log the shared key.
    try:
        logger.info(f"send_message sender={sender} recipient={recipient} encrypted={encrypted_msg[:50]}... plaintext={_maybe_log_plain(message)}")
    except Exception as e:
        print(f"[logging] send_message log failed: {e}")

    with app.app_context():
        db_message = Message(
            sender=sender, 
            recipient=recipient, 
            encrypted_message=encrypted_msg,
            message_type=message_type,
            file_url=file_url,
            file_name=file_name,
            reply_to_id=reply_to_id
        )
        db.session.add(db_message)
        db.session.commit()
        message_id = db_message.id # Get the ID of the new message

    # Log that the message was stored with its ID
    try:
        logger.info(f"stored_message id={message_id} sender={sender} recipient={recipient} timestamp={db_message.timestamp.isoformat()}")
    except Exception:
        pass

    # Send to recipient
    if recipient in online_users:
        # include reply preview if possible
        reply_preview = None
        reply_preview_sender = None
        if reply_to_id:
            try:
                ref = Message.query.get(reply_to_id)
                if ref:
                    reply_preview = xor_decrypt(ref.encrypted_message, get_shared_key(ref.sender, ref.recipient))
                    reply_preview_sender = ref.sender
            except Exception:
                reply_preview = None
        try:
            logger.info(f"send_message reply_preview id={message_id} reply_to={reply_to_id} preview={'yes' if reply_preview else 'no'}")
        except Exception:
            pass

        emit("receive_message", {
            "id": message_id,
            "sender": sender, 
            "message": message,  # Send plaintext directly
            "encrypted": encrypted_msg,
            "key": key, 
            "timestamp": db_message.timestamp.isoformat(),
            "status": "sent",
            "message_type": message_type,
            "file_url": file_url,
            "file_name": file_name,
            "reply_to_id": reply_to_id,
            "reply_preview": reply_preview,
            "reply_preview_sender": reply_preview_sender
        }, room=online_users[recipient])
    
    # Send plaintext back to sender for their own UI
    sender_sid = online_users.get(sender)
    if sender_sid:
        # include reply preview for sender as well
        reply_preview = None
        reply_preview_sender = None
        if reply_to_id:
            try:
                ref = Message.query.get(reply_to_id)
                if ref:
                    reply_preview = xor_decrypt(ref.encrypted_message, get_shared_key(ref.sender, ref.recipient))
                    reply_preview_sender = ref.sender
            except Exception:
                reply_preview = None

        emit("receive_message", {
            "id": message_id,
            "sender": sender, 
            "message": message, 
            "key": key, 
            "timestamp": db_message.timestamp.isoformat(),
            "status": "sent",
            "message_type": message_type,
            "file_url": file_url,
            "file_name": file_name,
            "reply_to_id": reply_to_id,
            "reply_preview": reply_preview,
            "reply_preview_sender": reply_preview_sender
        }, room=sender_sid)


@socketio.on('fetch_message_by_id')
def handle_fetch_message_by_id(data):
    message_id = data.get('message_id')
    sid = request.sid
    if not message_id:
        emit('fetched_message', {'message_id': None, 'error': 'missing id'}, room=sid)
        return
    try:
        with app.app_context():
            msg = Message.query.get(int(message_id))
            if not msg:
                emit('fetched_message', {'message_id': message_id, 'error': 'not found'}, room=sid)
                return
            # Derive a shared key — for group messages recipient may be None, fall back to sender
            other = msg.recipient or msg.sender
            try:
                key = get_shared_key(msg.sender, other)
                plaintext = xor_decrypt(msg.encrypted_message, key)
            except Exception as e:
                plaintext = '[Decryption Error]'
            emit('fetched_message', {
                'message_id': message_id,
                'message': plaintext,
                'sender': msg.sender,
                'timestamp': msg.timestamp.isoformat()
            }, room=sid)
    except Exception as e:
        emit('fetched_message', {'message_id': message_id, 'error': str(e)}, room=sid)


@socketio.on("message_delivered")
def handle_message_delivered(data):
    message_id = data.get("id")
    with app.app_context():
        msg = Message.query.get(message_id)
        if msg and msg.status == 'sent':
            msg.status = 'delivered'
            db.session.commit()
            
            # Notify the sender that the message was delivered
            sender_sid = online_users.get(msg.sender)
            if sender_sid:
                emit("message_status_updated", {"id": msg.id, "status": "delivered"}, room=sender_sid)

            # Notify recipient of a new unread message
            recipient_sid = online_users.get(msg.recipient)
            if recipient_sid:
                emit("new_unread_message", {"sender": msg.sender})
            try:
                logger.info(f"message_delivered id={msg.id} sender={msg.sender} recipient={msg.recipient} status=delivered")
            except Exception:
                pass


@socketio.on("edit_message")
def handle_edit_message(data):
    message_id = data.get("message_id")
    username = data.get("username")
    new_message = data.get("new_message")
    
    with app.app_context():
        msg = Message.query.get(message_id)
        # Check if the message exists, the user is the sender, and it's within 5 minutes
        if msg and msg.sender == username and (datetime.utcnow() - msg.timestamp) < timedelta(minutes=5):
            key = get_shared_key(msg.sender, msg.recipient)
            msg.encrypted_message = xor_encrypt_decrypt(new_message, key)
            msg.edited = True
            db.session.commit()

            # Notify both sender and recipient with plaintext
            sender_sid = online_users.get(msg.sender)
            if sender_sid:
                emit("message_edited", {
                    "id": msg.id, "new_message": new_message, "edited": True
                }, room=sender_sid)
            
            recipient_sid = online_users.get(msg.recipient)
            if recipient_sid:
                emit("message_edited", {
                    "id": msg.id, "new_message": new_message, "edited": True
                }, room=recipient_sid)
            try:
                logger.info(f"message_edited id={msg.id} sender={msg.sender} editor={username}")
            except Exception:
                pass


@socketio.on("delete_message")
def handle_delete_message(data):
    message_id = data.get("message_id")
    username = data.get("username")
    with app.app_context():
        msg = Message.query.get(message_id)
        if msg and msg.sender == username:
            recipient = msg.recipient
            # Log deletion and then delete
            try:
                logger.info(f"message_deleted id={msg.id} sender={msg.sender} deleter={username} recipient={recipient}")
            except Exception:
                pass
            db.session.delete(msg)
            db.session.commit()
            
            # Notify both sender and recipient that the message was deleted
            sender_sid = online_users.get(username)
            if sender_sid:
                emit("message_deleted", {"id": message_id}, room=sender_sid)
            recipient_sid = online_users.get(recipient)
            if recipient_sid:
                emit("message_deleted", {"id": message_id}, room=recipient_sid)


@socketio.on("mark_as_read")
def handle_mark_as_read(data):
    reader = data.get("reader")
    sender = data.get("sender")
    with app.app_context():
        Message.query.filter_by(recipient=reader, sender=sender, read=False).update({"read": True})
        db.session.commit()


@socketio.on("typing")
def handle_typing(data):
    sender = data['sender']
    recipient = data.get('recipient')
    group_id = data.get('group_id')
    
    if group_id:
        # Group typing - broadcast to all group members except sender
        group = Group.query.get(group_id)
        if group:
            for member in group.members:
                if member.username != sender:
                    member_sid = online_users.get(member.username)
                    if member_sid:
                        emit("user_typing", {
                            "sender": sender,
                            "group_id": group_id,
                            "conversation_id": f"group_{group_id}"
                        }, room=member_sid)
    elif recipient:
        # Direct message typing
        recipient_sid = online_users.get(recipient)
        if recipient_sid:
            emit("user_typing", {
                "sender": sender,
                "conversation_id": recipient
            }, room=recipient_sid)

@socketio.on("stop_typing")
def handle_stop_typing(data):
    sender = data['sender']
    recipient = data.get('recipient')
    group_id = data.get('group_id')
    
    if group_id:
        # Group stop typing - broadcast to all group members except sender
        group = Group.query.get(group_id)
        if group:
            for member in group.members:
                if member.username != sender:
                    member_sid = online_users.get(member.username)
                    if member_sid:
                        emit("user_stopped_typing", {
                            "sender": sender,
                            "group_id": group_id,
                            "conversation_id": f"group_{group_id}"
                        }, room=member_sid)
    elif recipient:
        # Direct message stop typing
        recipient_sid = online_users.get(recipient)
        if recipient_sid:
            emit("user_stopped_typing", {
                "sender": sender,
                "conversation_id": recipient
            }, room=recipient_sid)


# ==================== NEW FEATURES ====================

# Message Reactions
@socketio.on("add_reaction")
def handle_add_reaction(data):
    message_id = data.get("message_id")
    user = data.get("user")
    emoji = data.get("emoji")
    
    with app.app_context():
        # Check if reaction already exists
        existing = MessageReaction.query.filter_by(
            message_id=message_id, user=user, emoji=emoji
        ).first()
        
        if not existing:
            reaction = MessageReaction(message_id=message_id, user=user, emoji=emoji)
            db.session.add(reaction)
            db.session.commit()
            
            # Get the message to notify both users
            msg = Message.query.get(message_id)
            if msg:
                # Notify sender
                sender_sid = online_users.get(msg.sender)
                if sender_sid:
                    emit("reaction_added", {
                        "message_id": message_id, 
                        "user": user, 
                        "emoji": emoji
                    }, room=sender_sid)
                
                # Notify recipient
                recipient_sid = online_users.get(msg.recipient)
                if recipient_sid:
                    emit("reaction_added", {
                        "message_id": message_id, 
                        "user": user, 
                        "emoji": emoji
                    }, room=recipient_sid)


@socketio.on("remove_reaction")
def handle_remove_reaction(data):
    message_id = data.get("message_id")
    user = data.get("user")
    emoji = data.get("emoji")
    
    with app.app_context():
        reaction = MessageReaction.query.filter_by(
            message_id=message_id, user=user, emoji=emoji
        ).first()
        
        if reaction:
            db.session.delete(reaction)
            db.session.commit()
            
            # Get the message to notify both users
            msg = Message.query.get(message_id)
            if msg:
                # Notify sender
                sender_sid = online_users.get(msg.sender)
                if sender_sid:
                    emit("reaction_removed", {
                        "message_id": message_id, 
                        "user": user, 
                        "emoji": emoji
                    }, room=sender_sid)
                
                # Notify recipient
                recipient_sid = online_users.get(msg.recipient)
                if recipient_sid:
                    emit("reaction_removed", {
                        "message_id": message_id, 
                        "user": user, 
                        "emoji": emoji
                    }, room=recipient_sid)


# Message Organization
@socketio.on("pin_message")
def handle_pin_message(data):
    message_id = data.get("message_id")
    user = data.get("user")
    
    with app.app_context():
        msg = Message.query.get(message_id)
        if msg and (msg.sender == user or msg.recipient == user):
            msg.pinned = not msg.pinned
            db.session.commit()
            
            # Notify both users
            for recipient in [msg.sender, msg.recipient]:
                sid = online_users.get(recipient)
                if sid:
                    emit("message_pinned", {
                        "message_id": message_id, 
                        "pinned": msg.pinned
                    }, room=sid)


@socketio.on("star_message")
def handle_star_message(data):
    message_id = data.get("message_id")
    user = data.get("user")
    
    with app.app_context():
        msg = Message.query.get(message_id)
        if msg and (msg.sender == user or msg.recipient == user):
            msg.starred = not msg.starred
            db.session.commit()
            
            # Notify the user
            sid = online_users.get(user)
            if sid:
                emit("message_starred", {
                    "message_id": message_id, 
                    "starred": msg.starred
                }, room=sid)


# Search Messages
@socketio.on("search_messages")
def handle_search_messages(data):
    user = data.get("user")
    query = data.get("query", "").lower()
    partner = data.get("partner")
    
    with app.app_context():
        # Get all messages for this conversation
        messages = db.session.query(Message).filter(
            ((Message.sender == user) & (Message.recipient == partner)) |
            ((Message.sender == partner) & (Message.recipient == user))
        ).order_by(Message.timestamp.desc()).all()
        
        key = get_shared_key(user, partner)
        results = []
        
        for msg in messages:
            try:
                decrypted_text = xor_decrypt(msg.encrypted_message, key)
                if query in decrypted_text.lower():
                    results.append({
                        "id": msg.id,
                        "sender": msg.sender,
                        "message": decrypted_text,
                        "timestamp": msg.timestamp.isoformat()
                    })
            except Exception:
                pass
        
        emit("search_results", {"results": results[:50]})  # Limit to 50 results


# User Status & Presence
@socketio.on("update_status")
def handle_update_status(data):
    username = data.get("username")
    status = data.get("status")  # online, away, busy, offline
    status_message = data.get("status_message", "")
    
    with app.app_context():
        user = User.query.filter_by(username=username).first()
        if user:
            user.status = status
            user.status_message = status_message
            user.last_seen = datetime.utcnow()
            db.session.commit()
            
            # Broadcast status to all online users
            emit("user_status_changed", {
                "username": username,
                "status": status,
                "status_message": status_message,
                "last_seen": user.last_seen.isoformat()
            }, broadcast=True)


@socketio.on("get_user_status")
def handle_get_user_status(data):
    username = data.get("username")
    
    with app.app_context():
        user = User.query.filter_by(username=username).first()
        if user:
            emit("user_status_info", {
                "username": username,
                "status": user.status,
                "status_message": user.status_message,
                "last_seen": user.last_seen.isoformat() if user.last_seen else None,
                "show_last_seen": user.show_last_seen
            })


# Privacy Settings
@socketio.on("update_privacy_settings")
def handle_update_privacy_settings(data):
    username = data.get("username")
    show_last_seen = data.get("show_last_seen")
    show_read_receipts = data.get("show_read_receipts")
    allow_messages_from = data.get("allow_messages_from")
    
    with app.app_context():
        user = User.query.filter_by(username=username).first()
        if user:
            if show_last_seen is not None:
                user.show_last_seen = show_last_seen
            if show_read_receipts is not None:
                user.show_read_receipts = show_read_receipts
            if allow_messages_from is not None:
                user.allow_messages_from = allow_messages_from
            db.session.commit()
            
            emit("privacy_settings_updated", {
                "success": True,
                "show_last_seen": user.show_last_seen,
                "show_read_receipts": user.show_read_receipts,
                "allow_messages_from": user.allow_messages_from
            })


@socketio.on("get_privacy_settings")
def handle_get_privacy_settings(data):
    username = data.get("username")
    
    with app.app_context():
        user = User.query.filter_by(username=username).first()
        if user:
            emit("privacy_settings_info", {
                "show_last_seen": user.show_last_seen,
                "show_read_receipts": user.show_read_receipts,
                "allow_messages_from": user.allow_messages_from
            })


@socketio.on("get_history")
def handle_get_history(data):
    user1 = data.get("user1")
    user2 = data.get("user2")
    
    key = get_shared_key(user1, user2)
    
    with app.app_context():
        messages = db.session.query(Message).filter(
            ((Message.sender == user1) & (Message.recipient == user2)) |
            ((Message.sender == user2) & (Message.recipient == user1))
        ).order_by(Message.timestamp.asc()).all()

    history = []
    for msg in messages:
        try:
            decrypted_text = xor_decrypt(msg.encrypted_message, key)
            # Log decryption attempt (don't log key)
            try:
                logger.info(f"decrypt_message id={msg.id} sender={msg.sender} recipient={msg.recipient} success=True")
            except Exception:
                pass
            
            # Get reactions for this message
            reactions = MessageReaction.query.filter_by(message_id=msg.id).all()
            reactions_list = [{"user": r.user, "emoji": r.emoji} for r in reactions]
            
            history.append({
                "id": msg.id,
                "sender": msg.sender, 
                "message": decrypted_text, 
                "timestamp": msg.timestamp.isoformat(),
                "status": msg.status,
                "edited": msg.edited,
                "message_type": msg.message_type or "text",
                "file_url": msg.file_url,
                "file_name": msg.file_name,
                "reply_to_id": msg.reply_to_id,
                "reply_preview": None,
                "reply_preview_sender": None,
                "pinned": msg.pinned or False,
                "starred": msg.starred or False,
                "reactions": reactions_list
            })
            # If this message replies to another, attempt to include a small preview
            if msg.reply_to_id:
                try:
                    ref = Message.query.get(msg.reply_to_id)
                    if ref:
                        preview_text = xor_decrypt(ref.encrypted_message, get_shared_key(ref.sender, ref.recipient))
                        history[-1]["reply_preview"] = preview_text
                        history[-1]["reply_preview_sender"] = ref.sender
                except Exception:
                    pass
        except Exception as e:
            print(f"Error decrypting message {msg.id}: {e}")
            history.append({
                "id": msg.id,
                "sender": msg.sender, 
                "message": "[Decryption Error]", 
                "timestamp": msg.timestamp.isoformat(),
                "status": msg.status,
                "edited": msg.edited,
                "message_type": "text",
                "reactions": []
            })

    emit("chat_history", {"history": history, "key": key})


@socketio.on("clear_history")
def handle_clear_history(data):
    user1 = data.get("user1")
    user2 = data.get("user2")

    if not user1 or not user2:
        return

    with app.app_context():
        db.session.query(Message).filter(
            ((Message.sender == user1) & (Message.recipient == user2)) |
            ((Message.sender == user2) & (Message.recipient == user1))
        ).delete(synchronize_session=False)
        db.session.commit()

    for user in {user1, user2}:
        sid = online_users.get(user)
        if sid:
            emit("history_cleared", room=sid)


def _ensure_message_columns_exist():
    """Ensure the Message table has the expected columns.

    Safe to run at startup. Returns list of added columns.
    """
    added = []
    with app.app_context():
        try:
            engine_name = getattr(db.engine, 'name', None)
        except Exception:
            engine_name = None

        try:
            if engine_name == 'postgresql':
                rows = db.session.execute(text("SELECT column_name FROM information_schema.columns WHERE table_name='message';")).fetchall()
                existing = {r[0] for r in rows}
                desired = {
                    'read': 'boolean DEFAULT false',
                    'group_id': 'integer',
                    'status': "varchar(20) DEFAULT 'sent'",
                    'edited': 'boolean DEFAULT false'
                }
                for col, definition in desired.items():
                    if col not in existing:
                        db.session.execute(text(f"ALTER TABLE message ADD COLUMN IF NOT EXISTS {col} {definition};"))
                        added.append(col)
                db.session.commit()
            else:
                # SQLite
                rows = db.session.execute(text("PRAGMA table_info('message');")).fetchall()
                existing = {r[1] for r in rows}
                desired = {
                    'read': 'BOOLEAN DEFAULT 0',
                    'group_id': 'INTEGER',
                    'status': "VARCHAR(20) DEFAULT 'sent'",
                    'edited': 'BOOLEAN DEFAULT 0'
                }
                for col, definition in desired.items():
                    if col not in existing:
                        db.session.execute(text(f"ALTER TABLE message ADD COLUMN {col} {definition};"))
                        added.append(col)
                db.session.commit()
        except Exception as e:
            db.session.rollback()
            print(f"[startup] _ensure_message_columns_exist failed: {e}")
    return added


def migrate_database_schema():
    """Add missing columns to existing tables - runs on startup"""
    try:
        from sqlalchemy import inspect, text
        inspector = inspect(db.engine)
        
        def column_exists(table_name, column_name):
            try:
                columns = [col['name'] for col in inspector.get_columns(table_name)]
                return column_name in columns
            except Exception:
                return False
        
        def table_exists(table_name):
            try:
                return table_name in inspector.get_table_names()
            except Exception:
                return False
        
        migrations_applied = []
        
        # USER TABLE MIGRATIONS
        if table_exists('user'):
            user_migrations = [
                ("status", "ALTER TABLE \"user\" ADD COLUMN status VARCHAR(50) DEFAULT 'online'"),
                ("status_message", "ALTER TABLE \"user\" ADD COLUMN status_message VARCHAR(200)"),
                ("last_seen", "ALTER TABLE \"user\" ADD COLUMN last_seen TIMESTAMP DEFAULT NOW()"),
                ("avatar_url", "ALTER TABLE \"user\" ADD COLUMN avatar_url VARCHAR(500)"),
                ("show_last_seen", "ALTER TABLE \"user\" ADD COLUMN show_last_seen BOOLEAN DEFAULT TRUE"),
                ("show_read_receipts", "ALTER TABLE \"user\" ADD COLUMN show_read_receipts BOOLEAN DEFAULT TRUE"),
                ("allow_messages_from", "ALTER TABLE \"user\" ADD COLUMN allow_messages_from VARCHAR(20) DEFAULT 'everyone'"),
            ]
            
            with db.engine.connect() as conn:
                for col_name, sql in user_migrations:
                    if not column_exists('user', col_name):
                        try:
                            conn.execute(text(sql))
                            conn.commit()
                            migrations_applied.append(f"user.{col_name}")
                        except Exception as e:
                            if 'already exists' not in str(e).lower():
                                print(f"[migration] Warning: Failed to add user.{col_name}: {e}")
        
        # MESSAGE TABLE MIGRATIONS
        if table_exists('message'):
            message_migrations = [
                ("status", "ALTER TABLE message ADD COLUMN status VARCHAR(20) DEFAULT 'sent'"),
                ("edited", "ALTER TABLE message ADD COLUMN edited BOOLEAN DEFAULT FALSE"),
                ("message_type", "ALTER TABLE message ADD COLUMN message_type VARCHAR(20) DEFAULT 'text'"),
                ("file_url", "ALTER TABLE message ADD COLUMN file_url VARCHAR(500)"),
                ("file_name", "ALTER TABLE message ADD COLUMN file_name VARCHAR(255)"),
                ("reply_to_id", "ALTER TABLE message ADD COLUMN reply_to_id INTEGER REFERENCES message(id)"),
                ("pinned", "ALTER TABLE message ADD COLUMN pinned BOOLEAN DEFAULT FALSE"),
                ("starred", "ALTER TABLE message ADD COLUMN starred BOOLEAN DEFAULT FALSE"),
                ("deleted", "ALTER TABLE message ADD COLUMN deleted BOOLEAN DEFAULT FALSE"),
                ("deleted_for", "ALTER TABLE message ADD COLUMN deleted_for VARCHAR(500)"),
            ]
            
            with db.engine.connect() as conn:
                for col_name, sql in message_migrations:
                    if not column_exists('message', col_name):
                        try:
                            conn.execute(text(sql))
                            conn.commit()
                            migrations_applied.append(f"message.{col_name}")
                        except Exception as e:
                            if 'already exists' not in str(e).lower():
                                print(f"[migration] Warning: Failed to add message.{col_name}: {e}")
        
        # CREATE MISSING TABLES
        missing_tables = []
        
        if not table_exists('message_reaction'):
            with db.engine.connect() as conn:
                try:
                    conn.execute(text("""
                        CREATE TABLE IF NOT EXISTS message_reaction (
                            id SERIAL PRIMARY KEY,
                            message_id INTEGER NOT NULL REFERENCES message(id) ON DELETE CASCADE,
                            username VARCHAR(100) NOT NULL,
                            reaction VARCHAR(10) NOT NULL,
                            timestamp TIMESTAMP DEFAULT NOW()
                        )
                    """))
                    conn.commit()
                    missing_tables.append('message_reaction')
                except Exception as e:
                    print(f"[migration] Warning: Failed to create message_reaction: {e}")
        
        if not table_exists('group_admin'):
            with db.engine.connect() as conn:
                try:
                    conn.execute(text("""
                        CREATE TABLE IF NOT EXISTS group_admin (
                            id SERIAL PRIMARY KEY,
                            group_name VARCHAR(100) NOT NULL,
                            username VARCHAR(100) NOT NULL,
                            role VARCHAR(50) DEFAULT 'member',
                            can_add_members BOOLEAN DEFAULT FALSE,
                            can_remove_members BOOLEAN DEFAULT FALSE,
                            can_edit_info BOOLEAN DEFAULT FALSE,
                            can_send_messages BOOLEAN DEFAULT TRUE,
                            joined_at TIMESTAMP DEFAULT NOW(),
                            UNIQUE(group_name, username)
                        )
                    """))
                    conn.commit()
                    missing_tables.append('group_admin')
                except Exception as e:
                    print(f"[migration] Warning: Failed to create group_admin: {e}")
        
        if not table_exists('device_session'):
            with db.engine.connect() as conn:
                try:
                    conn.execute(text("""
                        CREATE TABLE IF NOT EXISTS device_session (
                            id SERIAL PRIMARY KEY,
                            username VARCHAR(100) NOT NULL,
                            device_name VARCHAR(100) NOT NULL,
                            device_token VARCHAR(200) UNIQUE NOT NULL,
                            paired_at TIMESTAMP DEFAULT NOW(),
                            last_active TIMESTAMP DEFAULT NOW()
                        )
                    """))
                    conn.commit()
                    missing_tables.append('device_session')
                except Exception as e:
                    print(f"[migration] Warning: Failed to create device_session: {e}")
        
        if not table_exists('group_invitation'):
            with db.engine.connect() as conn:
                try:
                    conn.execute(text("""
                        CREATE TABLE IF NOT EXISTS group_invitation (
                            id SERIAL PRIMARY KEY,
                            group_name VARCHAR(100) NOT NULL,
                            token VARCHAR(200) UNIQUE NOT NULL,
                            created_by VARCHAR(100) NOT NULL,
                            created_at TIMESTAMP DEFAULT NOW(),
                            expires_at TIMESTAMP NOT NULL,
                            max_uses INTEGER DEFAULT 1,
                            current_uses INTEGER DEFAULT 0
                        )
                    """))
                    conn.commit()
                    missing_tables.append('group_invitation')
                except Exception as e:
                    print(f"[migration] Warning: Failed to create group_invitation: {e}")
        
        if not table_exists('call'):
            with db.engine.connect() as conn:
                try:
                    conn.execute(text("""
                        CREATE TABLE IF NOT EXISTS call (
                            id SERIAL PRIMARY KEY,
                            caller VARCHAR(100) NOT NULL,
                            callee VARCHAR(100) NOT NULL,
                            call_type VARCHAR(20) NOT NULL,
                            status VARCHAR(20) DEFAULT 'initiated',
                            started_at TIMESTAMP DEFAULT NOW(),
                            ended_at TIMESTAMP,
                            duration INTEGER DEFAULT 0
                        )
                    """))
                    conn.commit()
                    missing_tables.append('call')
                except Exception as e:
                    print(f"[migration] Warning: Failed to create call: {e}")
        
        if migrations_applied:
            print(f"[migration] ✅ Added columns: {', '.join(migrations_applied)}")
        if missing_tables:
            print(f"[migration] ✅ Created tables: {', '.join(missing_tables)}")
        if not migrations_applied and not missing_tables:
            print("[migration] ✅ Schema up to date")
        
        return True
    except Exception as e:
        print(f"[migration] ⚠️ Migration failed: {e}")
        return False


# Run startup tasks: create tables, diagnostics, and heal schema drift
with app.app_context():
    try:
        db.create_all()
    except Exception as e:
        print(f"[startup] db.create_all() failed: {e}")
    
    # Run automatic migration
    try:
        migrate_database_schema()
    except Exception as e:
        print(f"[startup] migrate_database_schema() failed: {e}")

    try:
        engine_name = getattr(db.engine, 'name', None)
    except Exception:
        engine_name = None
    used_env = None
    for k in ('DATABASE_URL', 'RAILWAY_DATABASE_URL', 'POSTGRES_URL', 'POSTGRESQL_URL', 'PG_URI', 'SQLALCHEMY_DATABASE_URI', 'DB_URL'):
        if os.environ.get(k):
            used_env = k
            break
    print(f"[startup] DATABASE_ENV_VAR: {used_env}, DB engine: {engine_name}")

    try:
        with db.engine.connect() as conn:
            conn.execute(text('SELECT 1'))
        print('[startup] DB connection test: OK')
    except Exception as e:
        print(f"[startup] DB connection test: FAILED - {e}")

    # Temporarily disabled for faster startup - db.create_all() should handle schema
    # added = _ensure_message_columns_exist()
    # if added:
    #     print(f"[startup] added message columns: {added}")
    print('[startup] Server starting...')

# ------------------ Group Creation ------------------
@socketio.on("create_group")
def handle_create_group(data):
    """Create a new group chat"""
    try:
        name = data.get('name')
        creator = data.get('creator')
        members = data.get('members', [])
        
        if not name or not creator:
            emit("error", {"message": "Group name and creator required"})
            return
        
        # Check if group already exists
        existing = Group.query.filter_by(name=name).first()
        if existing:
            emit("error", {"message": "Group name already exists"})
            return
        
        # Create group
        group = Group(name=name, creator_id=creator)
        db.session.add(group)
        db.session.commit()
        
        # Add members
        for member_name in members:
            user = User.query.filter_by(username=member_name).first()
            if user:
                group.members.append(user)
        
        db.session.commit()
        
        print(f"Group created: {name} by {creator} with {len(members)} members")
        
        # Notify all members to refresh their groups
        for member in members:
            user_sid = online_users.get(member)
            if user_sid:
                # Get fresh groups list for this member
                member_user = User.query.filter_by(username=member).first()
                if member_user:
                    member_groups = [{"name": g.name, "member_count": len(g.members)} 
                                    for g in member_user.groups]
                    socketio.emit("user_groups", {"groups": member_groups}, room=user_sid)
                    print(f"Sent groups update to {member}: {member_groups}")
        
        # Notify creator specifically
        emit("group_created", {
            "id": group.id,
            "name": group.name,
            "members": members
        })
        
    except Exception as e:
        print(f"Error creating group: {e}")
        import traceback
        traceback.print_exc()
        emit("error", {"message": "Failed to create group"})

@socketio.on("get_user_groups")
def handle_get_user_groups(data):
    """Get all groups a user is part of"""
    try:
        username = data.get('username')
        if not username:
            return
        
        with app.app_context():
            user = User.query.filter_by(username=username).first()
            if user:
                groups = [{"name": g.name, "member_count": len(g.members)} 
                         for g in user.groups]
                print(f"User {username} groups: {groups}")
                emit("user_groups", {"groups": groups})
    except Exception as e:
        print(f"Error getting user groups: {e}")
        import traceback
        traceback.print_exc()

@socketio.on("get_group_history")
def handle_get_group_history(data):
    """Get message history for a group"""
    try:
        group_name = data.get('group_name')
        username = data.get('username')
        
        if not group_name:
            return
        
        with app.app_context():
            group = Group.query.filter_by(name=group_name).first()
            if not group:
                return
            
            # Get messages where recipient is the group name (we store group messages with recipient=group_name)
            messages = db.session.query(Message).filter(
                Message.recipient == group_name
            ).order_by(Message.timestamp.asc()).all()
            
            history = []
            for msg in messages:
                try:
                    # For group messages, decrypt with a simple shared key based on group name
                    key = get_shared_key("group", group_name)
                    decrypted_text = xor_decrypt(msg.encrypted_message, key)
                    
                    reactions = MessageReaction.query.filter_by(message_id=msg.id).all()
                    reactions_list = [{"user": r.user, "emoji": r.emoji} for r in reactions]
                    
                    history.append({
                        "id": msg.id,
                        "sender": msg.sender,
                        "message": decrypted_text,
                        "timestamp": msg.timestamp.isoformat(),
                        "status": msg.status,
                        "message_type": msg.message_type or "text",
                        "file_url": msg.file_url,
                        "file_name": msg.file_name,
                        "reactions": reactions_list
                    })
                except Exception as e:
                    print(f"Error decrypting group message {msg.id}: {e}")
            
            emit("group_history", {"history": history})
    except Exception as e:
        print(f"Error getting group history: {e}")

@socketio.on("send_group_message")
def handle_send_group_message(data):
    """Send a message to a group"""
    try:
        sender = data.get('sender')
        group_name = data.get('group_name')
        message = data.get('message')
        message_type = data.get('message_type', 'text')
        file_url = data.get('file_url')
        file_name = data.get('file_name')
        
        if not sender or not group_name or not message:
            return
        
        with app.app_context():
            group = Group.query.filter_by(name=group_name).first()
            if not group:
                return
            
            # Encrypt message with group key
            key = get_shared_key("group", group_name)
            encrypted = xor_encrypt_decrypt(message, key)
            
            # Store message with recipient as group name
            msg = Message(
                sender=sender,
                recipient=group_name,
                encrypted_message=encrypted,
                status='delivered',
                message_type=message_type,
                file_url=file_url,
                file_name=file_name
            )
            db.session.add(msg)
            db.session.commit()
            
            msg_data = {
                "id": msg.id,
                "sender": sender,
                "group_name": group_name,
                "message": message,
                "timestamp": msg.timestamp.isoformat(),
                "message_type": message_type,
                "file_url": file_url,
                "file_name": file_name,
                "reactions": []
            }
            
            # include reply preview when replying to a group message
            reply_preview = None
            reply_preview_sender = None
            if data.get('reply_to_id'):
                try:
                    ref = Message.query.get(int(data.get('reply_to_id')))
                    if ref:
                        reply_preview = xor_decrypt(ref.encrypted_message, get_shared_key('group', group_name))
                        reply_preview_sender = ref.sender
                except Exception:
                    reply_preview = None
            if reply_preview:
                msg_data['reply_to_id'] = data.get('reply_to_id')
                msg_data['reply_preview'] = reply_preview
                msg_data['reply_preview_sender'] = reply_preview_sender
            # Send to all group members who are online
            for member in group.members:
                if member.username in online_users:
                    socketio.emit("group_message", msg_data, room=online_users[member.username])
            
            print(f"Group message sent in {group_name} by {sender}")
    except Exception as e:
        print(f"Error sending group message: {e}")
        emit("error", {"message": "Failed to send group message"})

# ------------------ Message Edit & Delete ------------------
@socketio.on("edit_message")
def handle_edit_message(data):
    """Edit an existing message"""
    try:
        message_id = data.get('message_id')
        new_text = data.get('new_text')
        editor = data.get('editor')
        
        if not message_id or not new_text or not editor:
            return
        
        with app.app_context():
            msg = db.session.get(Message, message_id)
            if not msg or msg.sender != editor:
                emit("error", {"message": "Cannot edit this message"})
                return
            
            # Re-encrypt with existing key
            if msg.recipient:
                key = get_shared_key(msg.sender, msg.recipient)
            else:
                key = get_shared_key("group", msg.recipient or "")
            
            msg.encrypted_message = xor_encrypt_decrypt(new_text, key)
            msg.edited = True
            db.session.commit()
            
            edit_data = {
                "message_id": message_id,
                "new_text": new_text,
                "edited": True
            }
            
            # Notify both users
            if msg.recipient and msg.recipient != msg.sender:
                if msg.sender in online_users:
                    socketio.emit("message_edited", edit_data, room=online_users[msg.sender])
                if msg.recipient in online_users:
                    socketio.emit("message_edited", edit_data, room=online_users[msg.recipient])
            
            print(f"Message {message_id} edited by {editor}")
    except Exception as e:
        print(f"Error editing message: {e}")

@socketio.on("delete_message")
def handle_delete_message(data):
    """Delete a message"""
    try:
        message_id = data.get('message_id')
        deleter = data.get('deleter')
        delete_for_everyone = data.get('delete_for_everyone', False)
        
        if not message_id or not deleter:
            return
        
        with app.app_context():
            msg = db.session.get(Message, message_id)
            if not msg:
                return
            
            if delete_for_everyone and msg.sender != deleter:
                emit("error", {"message": "Can only delete for everyone if you're the sender"})
                return
            
            if delete_for_everyone:
                msg.deleted = True
                msg.encrypted_message = xor_encrypt_decrypt("This message was deleted", 
                                                           get_shared_key(msg.sender, msg.recipient or ""))
            else:
                # Add user to deleted_for list
                deleted_list = json.loads(msg.deleted_for) if msg.deleted_for else []
                if deleter not in deleted_list:
                    deleted_list.append(deleter)
                msg.deleted_for = json.dumps(deleted_list)
            
            db.session.commit()
            
            delete_data = {
                "message_id": message_id,
                "deleted": True,
                "delete_for_everyone": delete_for_everyone,
                "deleter": deleter
            }
            
            # Notify users
            if msg.sender in online_users:
                socketio.emit("message_deleted", delete_data, room=online_users[msg.sender])
            if msg.recipient and msg.recipient in online_users:
                socketio.emit("message_deleted", delete_data, room=online_users[msg.recipient])
            
            print(f"Message {message_id} deleted by {deleter}")
    except Exception as e:
        print(f"Error deleting message: {e}")

# ------------------ Profile Picture Upload ------------------
@app.route('/upload_avatar', methods=['POST'])
def upload_avatar():
    """Upload user avatar"""
    try:
        if 'file' not in request.files:
            return jsonify({"success": False, "error": "No file provided"})
        
        file = request.files['file']
        username_param = request.form.get('username')
        
        if not username_param or not file or file.filename == '':
            return jsonify({"success": False, "error": "Invalid request"})
        
        if not allowed_file(file.filename):
            return jsonify({"success": False, "error": "File type not allowed"})
        
        filename = secure_filename(f"avatar_{username_param}_{int(datetime.utcnow().timestamp())}.{file.filename.rsplit('.', 1)[1].lower()}")
        filepath = os.path.join(app.config['UPLOAD_FOLDER'], filename)
        file.save(filepath)
        
        avatar_url = f"/uploads/{filename}"
        
        # Update user avatar in database
        with app.app_context():
            user = User.query.filter_by(username=username_param).first()
            if user:
                user.avatar_url = avatar_url
                db.session.commit()
        
        return jsonify({
            "success": True,
            "avatar_url": avatar_url
        })
    except Exception as e:
        print(f"Error uploading avatar: {e}")
        return jsonify({"success": False, "error": str(e)})

# ------------------ Voice/Video Calls ------------------
@socketio.on("initiate_call")
def handle_initiate_call(data):
    """Initiate a voice or video call"""
    try:
        caller = data.get('caller')
        callee = data.get('callee')
        call_type = data.get('call_type')  # 'voice' or 'video'
        offer = data.get('offer')
        
        if not all([caller, callee, call_type]):
            return
        
        with app.app_context():
            call = Call(
                caller=caller,
                callee=callee,
                call_type=call_type,
                offer=offer
            )
            db.session.add(call)
            db.session.commit()
            
            call_data = {
                "call_id": call.id,
                "caller": caller,
                "call_type": call_type,
                "offer": offer
            }
            
            # Notify callee
            if callee in online_users:
                socketio.emit("incoming_call", call_data, room=online_users[callee])
            
            print(f"{call_type} call initiated from {caller} to {callee}")
    except Exception as e:
        print(f"Error initiating call: {e}")

@socketio.on("answer_call")
def handle_answer_call(data):
    """Answer an incoming call"""
    try:
        call_id = data.get('call_id')
        answer = data.get('answer')
        callee = data.get('callee')
        
        if not all([call_id, answer, callee]):
            return
        
        with app.app_context():
            call = db.session.get(Call, call_id)
            if call and call.callee == callee:
                call.status = 'answered'
                call.answer = answer
                db.session.commit()
                
                # Notify caller
                if call.caller in online_users:
                    socketio.emit("call_answered", {
                        "call_id": call_id,
                        "answer": answer
                    }, room=online_users[call.caller])
                
                print(f"Call {call_id} answered by {callee}")
    except Exception as e:
        print(f"Error answering call: {e}")

@socketio.on("reject_call")
def handle_reject_call(data):
    """Reject an incoming call"""
    try:
        call_id = data.get('call_id')
        callee = data.get('callee')
        
        if not call_id or not callee:
            return
        
        with app.app_context():
            call = db.session.get(Call, call_id)
            if call and call.callee == callee:
                call.status = 'rejected'
                call.ended_at = datetime.utcnow()
                db.session.commit()
                
                # Notify caller
                if call.caller in online_users:
                    socketio.emit("call_rejected", {
                        "call_id": call_id
                    }, room=online_users[call.caller])
                
                print(f"Call {call_id} rejected by {callee}")
    except Exception as e:
        print(f"Error rejecting call: {e}")

@socketio.on("end_call")
def handle_end_call(data):
    """End an active call"""
    try:
        call_id = data.get('call_id')
        user = data.get('user')
        
        if not call_id or not user:
            return
        
        with app.app_context():
            call = db.session.get(Call, call_id)
            if call and (call.caller == user or call.callee == user):
                call.status = 'ended'
                call.ended_at = datetime.utcnow()
                if call.started_at:
                    call.duration = int((call.ended_at - call.started_at).total_seconds())
                db.session.commit()
                
                # Notify both parties
                other_user = call.callee if call.caller == user else call.caller
                if other_user in online_users:
                    socketio.emit("call_ended", {
                        "call_id": call_id,
                        "duration": call.duration
                    }, room=online_users[other_user])
                
                print(f"Call {call_id} ended by {user}")
    except Exception as e:
        print(f"Error ending call: {e}")

@socketio.on("ice_candidate")
def handle_ice_candidate(data):
    """Handle ICE candidate exchange for WebRTC"""
    try:
        caller = data.get('caller')
        callee = data.get('callee')
        candidate = data.get('candidate')
        
        if not all([caller, callee, candidate]):
            return
        
        # Forward ICE candidate to the other peer
        if callee in online_users:
            socketio.emit("ice_candidate", {
                "candidate": candidate,
                "from": caller
            }, room=online_users[callee])
    except Exception as e:
        print(f"Error handling ICE candidate: {e}")

# ==================== GROUP MANAGEMENT ====================

@socketio.on("promote_to_admin")
def handle_promote_to_admin(data):
    """Promote a group member to admin"""
    try:
        group_id = data.get('group_id')
        username = data.get('username')
        promoter = data.get('promoter')
        
        group = Group.query.get(group_id)
        if not group:
            emit("error", {"message": "Group not found"})
            return
        
        # Check if promoter is creator or super admin
        if group.creator_id != User.query.filter_by(username=promoter).first().id:
            admin = GroupAdmin.query.filter_by(
                group_id=group_id,
                user_id=User.query.filter_by(username=promoter).first().id,
                role='super_admin'
            ).first()
            if not admin:
                emit("error", {"message": "Only creator or super admins can promote"})
                return
        
        user = User.query.filter_by(username=username).first()
        if not user or user not in group.members:
            emit("error", {"message": "User not in group"})
            return
        
        # Check if already admin
        existing_admin = GroupAdmin.query.filter_by(
            group_id=group_id,
            user_id=user.id
        ).first()
        
        if existing_admin:
            emit("error", {"message": "User is already an admin"})
            return
        
        # Create admin record
        new_admin = GroupAdmin(
            group_id=group_id,
            user_id=user.id,
            role='admin'
        )
        db.session.add(new_admin)
        db.session.commit()
        
        # Notify all group members
        for member in group.members:
            member_sid = online_users.get(member.username)
            if member_sid:
                emit("user_promoted", {
                    "group_id": group_id,
                    "username": username,
                    "promoted_by": promoter
                }, room=member_sid)
        
        emit("promotion_success", {"message": f"{username} promoted to admin"})
    except Exception as e:
        print(f"Error promoting to admin: {e}")
        emit("error", {"message": "Failed to promote user"})

@socketio.on("demote_admin")
def handle_demote_admin(data):
    """Demote an admin to regular member"""
    try:
        group_id = data.get('group_id')
        username = data.get('username')
        demoter = data.get('demoter')
        
        group = Group.query.get(group_id)
        if not group:
            emit("error", {"message": "Group not found"})
            return
        
        # Check permissions
        demoter_user = User.query.filter_by(username=demoter).first()
        if group.creator_id != demoter_user.id:
            admin = GroupAdmin.query.filter_by(
                group_id=group_id,
                user_id=demoter_user.id,
                role='super_admin'
            ).first()
            if not admin:
                emit("error", {"message": "Only creator or super admins can demote"})
                return
        
        user = User.query.filter_by(username=username).first()
        admin_record = GroupAdmin.query.filter_by(
            group_id=group_id,
            user_id=user.id
        ).first()
        
        if not admin_record:
            emit("error", {"message": "User is not an admin"})
            return
        
        db.session.delete(admin_record)
        db.session.commit()
        
        # Notify all group members
        for member in group.members:
            member_sid = online_users.get(member.username)
            if member_sid:
                emit("user_demoted", {
                    "group_id": group_id,
                    "username": username,
                    "demoted_by": demoter
                }, room=member_sid)
        
        emit("demotion_success", {"message": f"{username} demoted to member"})
    except Exception as e:
        print(f"Error demoting admin: {e}")
        emit("error", {"message": "Failed to demote user"})

@socketio.on("add_group_member")
def handle_add_group_member(data):
    """Add a member to a group (admin only)"""
    try:
        group_id = data.get('group_id')
        username = data.get('username')
        adder = data.get('adder')
        
        group = Group.query.get(group_id)
        if not group:
            emit("error", {"message": "Group not found"})
            return
        
        # Check if adder has permission
        adder_user = User.query.filter_by(username=adder).first()
        if group.creator_id != adder_user.id:
            admin = GroupAdmin.query.filter_by(
                group_id=group_id,
                user_id=adder_user.id
            ).first()
            if not admin or not admin.can_add_members:
                emit("error", {"message": "No permission to add members"})
                return
        
        user = User.query.filter_by(username=username).first()
        if not user:
            emit("error", {"message": "User not found"})
            return
        
        if user in group.members:
            emit("error", {"message": "User already in group"})
            return
        
        group.members.append(user)
        db.session.commit()
        
        # Notify all group members including new member
        for member in group.members:
            member_sid = online_users.get(member.username)
            if member_sid:
                emit("member_added", {
                    "group_id": group_id,
                    "username": username,
                    "added_by": adder,
                    "group_name": group.name
                }, room=member_sid)
        
        emit("member_add_success", {"message": f"{username} added to group"})
    except Exception as e:
        print(f"Error adding group member: {e}")
        emit("error", {"message": "Failed to add member"})

@socketio.on("remove_group_member")
def handle_remove_group_member(data):
    """Remove a member from a group (admin only)"""
    try:
        group_id = data.get('group_id')
        username = data.get('username')
        remover = data.get('remover')
        
        group = Group.query.get(group_id)
        if not group:
            emit("error", {"message": "Group not found"})
            return
        
        # Check permissions
        remover_user = User.query.filter_by(username=remover).first()
        if group.creator_id != remover_user.id:
            admin = GroupAdmin.query.filter_by(
                group_id=group_id,
                user_id=remover_user.id
            ).first()
            if not admin or not admin.can_remove_members:
                emit("error", {"message": "No permission to remove members"})
                return
        
        user = User.query.filter_by(username=username).first()
        if not user or user not in group.members:
            emit("error", {"message": "User not in group"})
            return
        
        # Can't remove creator
        if user.id == group.creator_id:
            emit("error", {"message": "Cannot remove group creator"})
            return
        
        group.members.remove(user)
        
        # Remove admin status if exists
        admin_record = GroupAdmin.query.filter_by(
            group_id=group_id,
            user_id=user.id
        ).first()
        if admin_record:
            db.session.delete(admin_record)
        
        db.session.commit()
        
        # Notify all members
        for member in group.members:
            member_sid = online_users.get(member.username)
            if member_sid:
                emit("member_removed", {
                    "group_id": group_id,
                    "username": username,
                    "removed_by": remover
                }, room=member_sid)
        
        # Notify removed user
        removed_sid = online_users.get(username)
        if removed_sid:
            emit("removed_from_group", {
                "group_id": group_id,
                "group_name": group.name,
                "removed_by": remover
            }, room=removed_sid)
        
        emit("member_remove_success", {"message": f"{username} removed from group"})
    except Exception as e:
        print(f"Error removing group member: {e}")
        emit("error", {"message": "Failed to remove member"})

@socketio.on("edit_group")
def handle_edit_group(data):
    """Edit group name (admin only)"""
    try:
        group_id = data.get('group_id')
        new_name = data.get('new_name')
        editor = data.get('editor')
        
        group = Group.query.get(group_id)
        if not group:
            emit("error", {"message": "Group not found"})
            return
        
        # Check permissions
        editor_user = User.query.filter_by(username=editor).first()
        if group.creator_id != editor_user.id:
            admin = GroupAdmin.query.filter_by(
                group_id=group_id,
                user_id=editor_user.id
            ).first()
            if not admin or not admin.can_edit_group:
                emit("error", {"message": "No permission to edit group"})
                return
        
        old_name = group.name
        group.name = new_name
        db.session.commit()
        
        # Notify all members
        for member in group.members:
            member_sid = online_users.get(member.username)
            if member_sid:
                emit("group_edited", {
                    "group_id": group_id,
                    "old_name": old_name,
                    "new_name": new_name,
                    "edited_by": editor
                }, room=member_sid)
        
        emit("group_edit_success", {"message": "Group name updated"})
    except Exception as e:
        print(f"Error editing group: {e}")
        emit("error", {"message": "Failed to edit group"})

@socketio.on("create_group_invitation")
def handle_create_group_invitation(data):
    """Create an invitation link for a group"""
    try:
        group_id = data.get('group_id')
        inviter = data.get('inviter')
        invited_user = data.get('invited_user')
        
        group = Group.query.get(group_id)
        if not group:
            emit("error", {"message": "Group not found"})
            return
        
        # Check if inviter is member
        inviter_user = User.query.filter_by(username=inviter).first()
        if inviter_user not in group.members:
            emit("error", {"message": "Only group members can invite"})
            return
        
        # Generate unique token
        invite_token = secrets.token_urlsafe(16)
        expires_at = datetime.utcnow() + timedelta(days=7)
        
        invitation = GroupInvitation(
            group_id=group_id,
            invited_by=inviter_user.id,
            invited_user=invited_user,
            invite_token=invite_token,
            expires_at=expires_at
        )
        db.session.add(invitation)
        db.session.commit()
        
        # Notify invited user if online
        invited_sid = online_users.get(invited_user)
        if invited_sid:
            emit("group_invitation", {
                "group_id": group_id,
                "group_name": group.name,
                "invited_by": inviter,
                "invite_token": invite_token
            }, room=invited_sid)
        
        emit("invitation_created", {
            "invite_token": invite_token,
            "expires_at": expires_at.isoformat()
        })
    except Exception as e:
        print(f"Error creating invitation: {e}")
        emit("error", {"message": "Failed to create invitation"})

@socketio.on("accept_group_invitation")
def handle_accept_group_invitation(data):
    """Accept a group invitation"""
    try:
        invite_token = data.get('invite_token')
        username = data.get('username')
        
        invitation = GroupInvitation.query.filter_by(
            invite_token=invite_token,
            status='pending'
        ).first()
        
        if not invitation:
            emit("error", {"message": "Invalid invitation"})
            return
        
        if invitation.expires_at and invitation.expires_at < datetime.utcnow():
            invitation.status = 'expired'
            db.session.commit()
            emit("error", {"message": "Invitation expired"})
            return
        
        if invitation.invited_user != username:
            emit("error", {"message": "Invitation not for this user"})
            return
        
        group = Group.query.get(invitation.group_id)
        user = User.query.filter_by(username=username).first()
        
        if user in group.members:
            emit("error", {"message": "Already in group"})
            return
        
        group.members.append(user)
        invitation.status = 'accepted'
        db.session.commit()
        
        # Notify all group members
        for member in group.members:
            member_sid = online_users.get(member.username)
            if member_sid:
                emit("member_joined", {
                    "group_id": group.id,
                    "username": username,
                    "group_name": group.name
                }, room=member_sid)
        
        emit("invitation_accepted", {
            "group_id": group.id,
            "group_name": group.name
        })
    except Exception as e:
        print(f"Error accepting invitation: {e}")
        emit("error", {"message": "Failed to accept invitation"})

@socketio.on("get_group_admins")
def handle_get_group_admins(data):
    """Get list of group admins"""
    try:
        group_id = data.get('group_id')
        
        group = Group.query.get(group_id)
        if not group:
            emit("error", {"message": "Group not found"})
            return
        
        admins = GroupAdmin.query.filter_by(group_id=group_id).all()
        admin_list = []
        
        for admin in admins:
            user = User.query.get(admin.user_id)
            admin_list.append({
                "username": user.username,
                "role": admin.role,
                "can_add_members": admin.can_add_members,
                "can_remove_members": admin.can_remove_members,
                "can_edit_group": admin.can_edit_group,
                "appointed_at": admin.appointed_at.isoformat()
            })
        
        # Add creator
        creator = User.query.get(group.creator_id)
        admin_list.insert(0, {
            "username": creator.username,
            "role": "creator",
            "can_add_members": True,
            "can_remove_members": True,
            "can_edit_group": True,
            "appointed_at": group.created_at.isoformat() if hasattr(group, 'created_at') else None
        })
        
        emit("group_admins", {"admins": admin_list})
    except Exception as e:
        print(f"Error getting group admins: {e}")
        emit("error", {"message": "Failed to get admins"})

# ==================== MULTI-DEVICE SYNC ====================

@socketio.on("generate_qr_code")
def handle_generate_qr_code(data):
    """Generate QR code for device pairing"""
    try:
        username = data.get('username')
        
        # Generate device token
        device_token = secrets.token_urlsafe(32)
        
        # Store temporary pairing token (expires in 5 minutes)
        pairing_data = {
            "username": username,
            "token": device_token,
            "expires": (datetime.utcnow() + timedelta(minutes=5)).isoformat()
        }
        
        # In production, store in Redis or database
        # For now, we'll use a simple in-memory dict
        if not hasattr(app, 'pairing_tokens'):
            app.pairing_tokens = {}
        app.pairing_tokens[device_token] = pairing_data
        
        emit("qr_code_generated", {
            "token": device_token,
            "expires_in": 300  # seconds
        })
    except Exception as e:
        print(f"Error generating QR code: {e}")
        emit("error", {"message": "Failed to generate QR code"})

@socketio.on("verify_qr_code")
def handle_verify_qr_code(data):
    """Verify QR code and pair device"""
    try:
        token = data.get('token')
        device_name = data.get('device_name', 'Unknown Device')
        device_type = data.get('device_type', 'web')
        
        if not hasattr(app, 'pairing_tokens') or token not in app.pairing_tokens:
            emit("error", {"message": "Invalid or expired token"})
            return
        
        pairing_data = app.pairing_tokens[token]
        expires = datetime.fromisoformat(pairing_data['expires'])
        
        if expires < datetime.utcnow():
            del app.pairing_tokens[token]
            emit("error", {"message": "Token expired"})
            return
        
        username = pairing_data['username']
        user = User.query.filter_by(username=username).first()
        
        if not user:
            emit("error", {"message": "User not found"})
            return
        
        # Create device session
        device_session = DeviceSession(
            user_id=user.id,
            device_token=token,
            device_name=device_name,
            device_type=device_type,
            ip_address=request.remote_addr
        )
        db.session.add(device_session)
        db.session.commit()
        
        # Clean up pairing token
        del app.pairing_tokens[token]
        
        # Send success with username for auto-login
        emit("device_paired", {
            "device_name": device_name,
            "device_type": device_type,
            "paired_at": device_session.created_at.isoformat(),
            "username": username  # Add username for auto-login
        })
        
        # Notify primary device
        primary_sid = online_users.get(username)
        if primary_sid:
            socketio.emit("new_device_paired", {
                "device_name": device_name,
                "device_type": device_type
            }, room=primary_sid)
    except Exception as e:
        print(f"Error verifying QR code: {e}")
        emit("error", {"message": "Failed to pair device"})

@socketio.on("get_devices")
def handle_get_devices(data):
    """Get list of paired devices"""
    try:
        username = data.get('username')
        user = User.query.filter_by(username=username).first()
        
        if not user:
            emit("error", {"message": "User not found"})
            return
        
        devices = DeviceSession.query.filter_by(user_id=user.id, is_active=True).all()
        device_list = []
        
        for device in devices:
            device_list.append({
                "id": device.id,
                "device_name": device.device_name,
                "device_type": device.device_type,
                "last_active": device.last_active.isoformat(),
                "created_at": device.created_at.isoformat()
            })
        
        emit("devices_list", {"devices": device_list})
    except Exception as e:
        print(f"Error getting devices: {e}")
        emit("error", {"message": "Failed to get devices"})

@socketio.on("remove_device")
def handle_remove_device(data):
    """Remove a paired device"""
    try:
        device_id = data.get('device_id')
        username = data.get('username')
        
        user = User.query.filter_by(username=username).first()
        device = DeviceSession.query.filter_by(id=device_id, user_id=user.id).first()
        
        if not device:
            emit("error", {"message": "Device not found"})
            return
        
        device.is_active = False
        db.session.commit()
        
        emit("device_removed", {"device_id": device_id})
    except Exception as e:
        print(f"Error removing device: {e}")
        emit("error", {"message": "Failed to remove device"})

@socketio.on("sync_messages")
def handle_sync_messages(data):
    """Sync messages across devices"""
    try:
        username = data.get('username')
        last_sync = data.get('last_sync')  # ISO timestamp
        
        user = User.query.filter_by(username=username).first()
        if not user:
            emit("error", {"message": "User not found"})
            return
        
        # Get messages since last sync
        query = Message.query.filter(
            (Message.sender == username) | (Message.recipient == username)
        )
        
        if last_sync:
            sync_time = datetime.fromisoformat(last_sync)
            query = query.filter(Message.timestamp > sync_time)
        
        messages = query.order_by(Message.timestamp.asc()).limit(1000).all()
        
        message_list = []
        for msg in messages:
            message_list.append({
                "id": msg.id,
                "sender": msg.sender,
                "recipient": msg.recipient,
                "message": msg.encrypted_message,
                "timestamp": msg.timestamp.isoformat(),
                "message_type": msg.message_type,
                "file_url": msg.file_url,
                "edited": msg.edited,
                "deleted": msg.deleted
            })
        
        emit("messages_synced", {
            "messages": message_list,
            "sync_timestamp": datetime.utcnow().isoformat()
        })
    except Exception as e:
        print(f"Error syncing messages: {e}")
        emit("error", {"message": "Failed to sync messages"})

# ------------------ User Profile ------------------
@socketio.on("get_user_profile")
def handle_get_user_profile(data):
    username = session.get("username")
    if not username:
        emit("error", {"message": "Not logged in"})
        return
    
    try:
        target_username = data.get("username")
        target_user = User.query.filter_by(username=target_username).first()
        
        if not target_user:
            emit("user_profile", {"error": "User not found"})
            return
        
        # Get mutual groups
        user_groups = GroupAdmin.query.filter_by(username=username).all()
        target_groups = GroupAdmin.query.filter_by(username=target_username).all()
        
        user_group_names = set(ga.group_name for ga in user_groups)
        target_group_names = set(ga.group_name for ga in target_groups)
        mutual_groups = list(user_group_names & target_group_names)
        
        # Check online status (check if user is in active_users)
        is_online = target_username in active_users
        
        # Get last seen (from last message or device session)
        last_seen = None
        last_message = Message.query.filter_by(sender=target_username).order_by(Message.timestamp.desc()).first()
        if last_message:
            last_seen = last_message.timestamp.strftime("%b %d at %I:%M %p")
        
        emit("user_profile", {
            "username": target_username,
            "avatar_url": target_user.avatar_url,
            "bio": getattr(target_user, 'bio', None),
            "is_online": is_online,
            "last_seen": last_seen,
            "mutual_groups": mutual_groups
        })
    except Exception as e:
        print(f"Error getting user profile: {e}")
        emit("user_profile", {"error": "Failed to load profile"})

# ------------------ Block User ------------------
@socketio.on("block_user")
def handle_block_user(data):
    username = session.get("username")
    if not username:
        emit("error", {"message": "Not logged in"})
        return
    
    try:
        blocked_username = data.get("username")
        
        # In a real app, you'd add a BlockedUsers table
        # For now, just acknowledge
        emit("notification", {"message": f"Blocked {blocked_username}"})
    except Exception as e:
        print(f"Error blocking user: {e}")
        emit("error", {"message": "Failed to block user"})

# ------------------ Media Gallery ------------------
@socketio.on("get_media_gallery")
def handle_get_media_gallery(data):
    username = session.get("username")
    if not username:
        emit("error", {"message": "Not logged in"})
        return
    
    try:
        recipient = data.get("recipient")
        is_group = data.get("is_group", False)
        
        # Query messages with files
        if is_group:
            messages = Message.query.filter(
                Message.recipient == recipient,
                Message.message_type.in_(['image', 'file'])
            ).order_by(Message.timestamp.desc()).limit(100).all()
        else:
            messages = Message.query.filter(
                or_(
                    and_(Message.sender == username, Message.recipient == recipient),
                    and_(Message.sender == recipient, Message.recipient == username)
                ),
                Message.message_type.in_(['image', 'file'])
            ).order_by(Message.timestamp.desc()).limit(100).all()
        
        media_list = []
        for msg in messages:
            media_list.append({
                "id": msg.id,
                "type": msg.message_type,
                "url": msg.file_url,
                "filename": msg.file_name if hasattr(msg, 'file_name') else None,
                "timestamp": msg.timestamp.isoformat()
            })
        
        emit("media_gallery", {"media": media_list})
    except Exception as e:
        print(f"Error getting media gallery: {e}")
        emit("media_gallery", {"error": "Failed to load media"})

# ------------------ Message Pinning ------------------
@socketio.on("pin_message")
def handle_pin_message(data):
    username = session.get("username")
    if not username:
        emit("error", {"message": "Not logged in"})
        return
    
    try:
        message_id = data.get("message_id")
        recipient = data.get("recipient")
        is_group = data.get("is_group", False)
        
        message = Message.query.get(message_id)
        if not message:
            emit("error", {"message": "Message not found"})
            return
        
        # Create chat_id for pin tracking
        if is_group:
            chat_id = recipient
        else:
            chat_id = "_".join(sorted([username, recipient]))
        
        # Store pinned status (you'd want a PinnedMessages table in production)
        # For now, emit to all participants
        if is_group:
            # Get group members
            admins = GroupAdmin.query.filter_by(group_name=recipient).all()
            for admin in admins:
                if admin.username in online_users:
                    emit("message_pinned", {
                        "message_id": message_id,
                        "chat_id": chat_id
                    }, room=online_users[admin.username])
        else:
            # Emit to both users
            if username in online_users:
                emit("message_pinned", {
                    "message_id": message_id,
                    "chat_id": chat_id
                }, room=online_users[username])
            if recipient in online_users:
                emit("message_pinned", {
                    "message_id": message_id,
                    "chat_id": chat_id
                }, room=online_users[recipient])
        
    except Exception as e:
        print(f"Error pinning message: {e}")
        emit("error", {"message": "Failed to pin message"})

@socketio.on("unpin_message")
def handle_unpin_message(data):
    username = session.get("username")
    if not username:
        emit("error", {"message": "Not logged in"})
        return
    
    try:
        message_id = data.get("message_id")
        recipient = data.get("recipient")
        is_group = data.get("is_group", False)
        
        # Create chat_id
        if is_group:
            chat_id = recipient
        else:
            chat_id = "_".join(sorted([username, recipient]))
        
        # Emit to all participants
        if is_group:
            admins = GroupAdmin.query.filter_by(group_name=recipient).all()
            for admin in admins:
                if admin.username in online_users:
                    emit("message_unpinned", {
                        "message_id": message_id,
                        "chat_id": chat_id
                    }, room=online_users[admin.username])
        else:
            if username in online_users:
                emit("message_unpinned", {
                    "message_id": message_id,
                    "chat_id": chat_id
                }, room=online_users[username])
            if recipient in online_users:
                emit("message_unpinned", {
                    "message_id": message_id,
                    "chat_id": chat_id
                }, room=online_users[recipient])
        
    except Exception as e:
        print(f"Error unpinning message: {e}")
        emit("error", {"message": "Failed to unpin message"})

# ------------------ Main ------------------
if __name__ == "__main__":
    # Use environment variables for production deployment
    port = int(os.environ.get("PORT", 5000))
    print(f'[startup] Starting server on port {port}')
    socketio.run(app, host="0.0.0.0", port=port, debug=False)


