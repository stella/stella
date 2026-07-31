"""Container-local health probe for the PaddleX serving endpoint."""

from urllib.request import urlopen

HEALTH_URL = "http://127.0.0.1:8080/health"
HEALTH_TIMEOUT_SECONDS = 4


def main() -> None:
    """Exit unsuccessfully unless PaddleX answers its local health endpoint."""
    with urlopen(HEALTH_URL, timeout=HEALTH_TIMEOUT_SECONDS) as response:
        response.read()


if __name__ == "__main__":
    main()
