"""Password hashing, sessions and the login_required decorator."""
import hashlib
import hmac
import secrets
from functools import wraps

ITERATIONS = 260_000


def hash_password(password):
    """Hash a password with PBKDF2."""
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), b"taskboard", ITERATIONS)
    return digest.hex()


def verify_password(password, password_hash):
    """Check a password against a stored hash in constant time."""
    return hmac.compare_digest(hash_password(password), password_hash)


def create_session_token():
    return secrets.token_urlsafe(32)


def authenticate(store, username, password):
    """Return the user when the username and password match."""
    user = store.users.get(username)
    if user and verify_password(password, user.password_hash):
        return user
    return None


def login_required(view):
    @wraps(view)
    def wrapper(request, *args, **kwargs):
        if not request.get("session"):
            return {"error": "login required"}, 401
        return view(request, *args, **kwargs)

    return wrapper
