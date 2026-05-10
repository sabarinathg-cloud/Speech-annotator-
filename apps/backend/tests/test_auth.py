from app.core.security import create_access_token, create_refresh_token, get_password_hash, verify_password


def test_password_hashes_verify_and_support_existing_passlib_pbkdf2_hashes():
    password_hash = get_password_hash("Admin@123")
    assert verify_password("Admin@123", password_hash)
    assert not verify_password("wrong-password", password_hash)

    existing_hash = "$pbkdf2-sha256$29000$AqC09t57793b27s3Zuwdww$eWEpcLZoR4R0imLB1tI4Fx4zFh30WwhhVooqmhZcFC8"
    assert verify_password("Admin@123", existing_hash)


def test_login_and_me(client, seed_users):
    login_response = client.post(
        "/api/v1/auth/login",
        json={"email": "admin@test.com", "password": "Admin@123"},
    )
    assert login_response.status_code == 200
    payload = login_response.json()
    assert payload["user"]["role"] == "ADMIN"

    me_response = client.get(
        "/api/v1/auth/me",
        headers={"Authorization": f"Bearer {payload['access_token']}"},
    )
    assert me_response.status_code == 200
    assert me_response.json()["email"] == "admin@test.com"


def test_refresh_token_returns_new_session(client, seed_users):
    login_response = client.post(
        "/api/v1/auth/login",
        json={"email": "admin@test.com", "password": "Admin@123"},
    )
    assert login_response.status_code == 200

    refresh_response = client.post(
        "/api/v1/auth/refresh",
        json={"refresh_token": login_response.json()["refresh_token"]},
    )
    assert refresh_response.status_code == 200
    assert refresh_response.json()["user"]["email"] == "admin@test.com"
    assert refresh_response.json()["access_token"]


def test_second_login_invalidates_previous_access_token(client, seed_users):
    first_login = client.post(
        "/api/v1/auth/login",
        json={"email": "admin@test.com", "password": "Admin@123"},
    )
    assert first_login.status_code == 200

    second_login = client.post(
        "/api/v1/auth/login",
        json={"email": "admin@test.com", "password": "Admin@123"},
    )
    assert second_login.status_code == 200

    old_session = client.get(
        "/api/v1/auth/me",
        headers={"Authorization": f"Bearer {first_login.json()['access_token']}"},
    )
    assert old_session.status_code == 401
    assert old_session.json()["detail"]["message"] == "Session ended because this account signed in on another device."

    active_session = client.get(
        "/api/v1/auth/me",
        headers={"Authorization": f"Bearer {second_login.json()['access_token']}"},
    )
    assert active_session.status_code == 200
    assert active_session.json()["email"] == "admin@test.com"


def test_second_login_invalidates_previous_refresh_token(client, seed_users):
    first_login = client.post(
        "/api/v1/auth/login",
        json={"email": "admin@test.com", "password": "Admin@123"},
    )
    assert first_login.status_code == 200

    second_login = client.post(
        "/api/v1/auth/login",
        json={"email": "admin@test.com", "password": "Admin@123"},
    )
    assert second_login.status_code == 200

    old_refresh = client.post(
        "/api/v1/auth/refresh",
        json={"refresh_token": first_login.json()["refresh_token"]},
    )
    assert old_refresh.status_code == 401
    assert old_refresh.json()["detail"]["message"] == "Session ended because this account signed in on another device."

    active_refresh = client.post(
        "/api/v1/auth/refresh",
        json={"refresh_token": second_login.json()["refresh_token"]},
    )
    assert active_refresh.status_code == 200
    assert active_refresh.json()["user"]["email"] == "admin@test.com"


def test_tokens_without_device_session_are_rejected(client, seed_users):
    user = seed_users["admin"]
    access_token = create_access_token(user.id, user.role.value)
    refresh_token = create_refresh_token(user.id, user.role.value)

    me_response = client.get(
        "/api/v1/auth/me",
        headers={"Authorization": f"Bearer {access_token}"},
    )
    assert me_response.status_code == 401
    assert me_response.json()["detail"]["message"] == "Session ended because this account signed in on another device."

    refresh_response = client.post(
        "/api/v1/auth/refresh",
        json={"refresh_token": refresh_token},
    )
    assert refresh_response.status_code == 401
    assert refresh_response.json()["detail"]["message"] == "Session ended because this account signed in on another device."


def test_mobile_device_cannot_login(client, seed_users):
    response = client.post(
        "/api/v1/auth/login",
        json={"email": "admin@test.com", "password": "Admin@123"},
        headers={
            "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1"
        },
    )

    assert response.status_code == 403
    assert response.json()["detail"]["message"] == "This application can only be used from a laptop or desktop browser."


def test_mobile_device_cannot_refresh_or_use_existing_token(client, seed_users):
    login_response = client.post(
        "/api/v1/auth/login",
        json={"email": "admin@test.com", "password": "Admin@123"},
    )
    assert login_response.status_code == 200
    payload = login_response.json()
    mobile_headers = {
        "User-Agent": "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/123.0 Mobile Safari/537.36"
    }

    refresh_response = client.post(
        "/api/v1/auth/refresh",
        json={"refresh_token": payload["refresh_token"]},
        headers=mobile_headers,
    )
    assert refresh_response.status_code == 403
    assert refresh_response.json()["detail"]["message"] == "This application can only be used from a laptop or desktop browser."

    me_response = client.get(
        "/api/v1/auth/me",
        headers={**mobile_headers, "Authorization": f"Bearer {payload['access_token']}"},
    )
    assert me_response.status_code == 403
    assert me_response.json()["detail"]["message"] == "This application can only be used from a laptop or desktop browser."


def test_failed_login_is_rate_limited(client, seed_users):
    for _ in range(5):
        response = client.post(
            "/api/v1/auth/login",
            json={"email": "admin@test.com", "password": "wrong-password"},
        )
        assert response.status_code == 401

    blocked = client.post(
        "/api/v1/auth/login",
        json={"email": "admin@test.com", "password": "wrong-password"},
    )
    assert blocked.status_code == 429
    assert blocked.json()["detail"]["message"] == "Too many failed login attempts. Try again later."
