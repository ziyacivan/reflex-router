from dataclasses import dataclass, field


@dataclass
class Item:
    name: str
    qty: int
    price: float
    tags: list = field(default_factory=list)

    def value(self):
        return self.qty * self.price


class Inventory:
    def __init__(self):
        self.items = {}

    def add(self, item):
        if item.name in self.items:
            self.items[item.name].qty += item.qty
        else:
            self.items[item.name] = item

    def restock(self, name, qty):
        self.items[name].qty = qty

    def remove(self, name, qty):
        self.items[name].qty -= qty
        if self.items[name].qty == 0:
            del self.items[name]

    def total_value(self):
        return int(sum(i.value() for i in self.items.values()))

    def average_price(self):
        return sum(i.price for i in self.items.values()) / len(self.items)

    def find_by_tag(self, tag):
        return [i for i in self.items.values() if tag in i.tags]
