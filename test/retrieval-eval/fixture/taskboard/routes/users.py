"""User endpoints: register, login and profile."""
from ..auth import authenticate, create_session_token, hash_password, login_required
from ..models import User


def register(app):
    app.add_url_rule("/users", "register_user", register_user, methods=["POST"])
    app.add_url_rule("/login", "login", login, methods=["POST"])
    app.add_url_rule("/me", "profile", profile)


def register_user(request, store):
    data = request["json"]
    user = User(id=len(store.users) + 1, username=data["username"], email=data["email"],
                password_hash=hash_password(data["password"]))
    store.users[user.username] = user
    return {"id": user.id, "username": user.username}, 201


def login(request, store):
    """Log a user in with username and password and start a session."""
    data = request["json"]
    user = authenticate(store, data["username"], data["password"])
    if user is None:
        return {"error": "invalid credentials"}, 401
    return {"session": create_session_token()}


@login_required
def profile(request, store):
    return {"username": request["user"].username}
