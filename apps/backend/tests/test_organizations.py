def test_admin_can_create_and_update_organization_instructions(client, auth_headers):
    instructions = "Listen fully before saving.\nUse commas, punctuation, and special characters when needed."
    create_response = client.post(
        "/api/v1/organizations",
        headers=auth_headers["admin"],
        json={
            "name": "Clinical QA",
            "slug": "clinical-qa",
            "instructions": instructions,
        },
    )

    assert create_response.status_code == 200
    organization = create_response.json()
    assert organization["instructions"] == instructions

    me_response = client.get("/api/v1/auth/me", headers=auth_headers["admin"])
    assert me_response.status_code == 200
    org_access = next(item for item in me_response.json()["organizations"] if item["id"] == organization["id"])
    assert org_access["settings"]["instructions"] == instructions

    update_response = client.patch(
        f"/api/v1/organizations/{organization['id']}",
        headers=auth_headers["admin"],
        json={"instructions": ""},
    )

    assert update_response.status_code == 200
    assert update_response.json()["instructions"] is None
