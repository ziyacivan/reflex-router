import sys

from inventory.models import Inventory
from inventory.parse import load
from inventory.report import format_report


def main(argv):
    inv = Inventory()
    for item in load(argv[1]):
        inv.add(item)
    print(format_report(inv))


if __name__ == "__main__":
    main(sys.argv)
