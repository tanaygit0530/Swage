from taskboard.auth import hash_password, verify_password


def test_hash_and_verify():
    hashed = hash_password("correct horse")
    assert verify_password("correct horse", hashed)
    assert not verify_password("wrong", hashed)
