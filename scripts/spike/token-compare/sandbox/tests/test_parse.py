import unittest

from inventory.parse import parse_line, parse_lines


class ParseTest(unittest.TestCase):
    def test_simple(self):
        item = parse_line("bolt,100,0.10")
        self.assertEqual((item.name, item.qty, item.price), ("bolt", 100, 0.10))

    def test_whitespace(self):
        item = parse_line("widget, 10, 2.50")
        self.assertEqual(item.name, "widget")
        self.assertEqual(item.qty, 10)

    def test_name_is_trimmed(self):
        item = parse_line(" gizmo , 7 ,3.25")
        self.assertEqual(item.name, "gizmo")

    def test_comments_skipped(self):
        self.assertEqual(parse_lines(["# header", "a,1,1.0"])[0].name, "a")


if __name__ == "__main__":
    unittest.main()
