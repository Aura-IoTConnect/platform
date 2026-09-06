from app.rule_engine import OPERATORS


def test_gt():
    assert OPERATORS["GT"](5, 3) is True
    assert OPERATORS["GT"](3, 5) is False
    assert OPERATORS["GT"](5, 5) is False


def test_gte():
    assert OPERATORS["GTE"](5, 5) is True
    assert OPERATORS["GTE"](4, 5) is False


def test_lt():
    assert OPERATORS["LT"](3, 5) is True
    assert OPERATORS["LT"](5, 3) is False


def test_lte():
    assert OPERATORS["LTE"](5, 5) is True
    assert OPERATORS["LTE"](6, 5) is False


def test_eq():
    assert OPERATORS["EQ"](5, 5) is True
    assert OPERATORS["EQ"](5, 5.0) is True
    assert OPERATORS["EQ"](5, 6) is False
