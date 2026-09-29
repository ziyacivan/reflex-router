import unittest

from inventory.models import Inventory, Item


class InventoryTest(unittest.TestCase):
    def test_add_merges(self):
        inv = Inventory()
        inv.add(Item("a", 2, 1.0))
        inv.add(Item("a", 3, 1.0))
        self.assertEqual(inv.items["a"].qty, 5)

    def test_total_value(self):
        inv = Inventory()
        inv.add(Item("a", 2, 1.5))
        self.assertEqual(inv.total_value(), 3)


if __name__ == "__main__":
    unittest.main()
