from .models import Item


def parse_line(line):
    name, qty, price = line.split(",")
    return Item(name, int(qty), float(price))


def parse_lines(lines):
    items = []
    for line in lines:
        if not line or line.startswith("#"):
            continue
        items.append(parse_line(line))
    return items


def load(path):
    with open(path) as f:
        return parse_lines(f.read().splitlines())
