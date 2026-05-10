from fastapi import HTTPException, Request, status

LAPTOP_OR_DESKTOP_ONLY_MESSAGE = "This application can only be used from a laptop or desktop browser."

MOBILE_OR_TABLET_MARKERS = (
    "android",
    "bb10",
    "blackberry",
    "fennec",
    "ipad",
    "iphone",
    "ipod",
    "kindle",
    "mobile",
    "opera mini",
    "phone",
    "playbook",
    "silk/",
    "tablet",
    "windows phone",
)

DESKTOP_OR_TEST_MARKERS = (
    "cros",
    "linux x86_64",
    "linux i686",
    "macintosh",
    "testclient",
    "windows nt",
    "x11",
)


def is_laptop_or_desktop_request(user_agent: str | None, sec_ch_ua_mobile: str | None = None) -> bool:
    if sec_ch_ua_mobile and sec_ch_ua_mobile.strip() == "?1":
        return False
    normalized_user_agent = (user_agent or "").lower()
    if not normalized_user_agent:
        return False
    if any(marker in normalized_user_agent for marker in MOBILE_OR_TABLET_MARKERS):
        return False
    return any(marker in normalized_user_agent for marker in DESKTOP_OR_TEST_MARKERS)


def require_laptop_or_desktop_device(request: Request) -> None:
    if is_laptop_or_desktop_request(
        request.headers.get("user-agent"),
        request.headers.get("sec-ch-ua-mobile"),
    ):
        return
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail={"message": LAPTOP_OR_DESKTOP_ONLY_MESSAGE},
    )
