import os
import unittest
from unittest.mock import patch

from migrate_trading import (
    clear_protected_actions,
    clear_protected_databases,
    migrations,
    remove_unused_references,
)


class RemoveUnusedReferencesTest(unittest.TestCase):
    def test_clear_protected_databases_parses_exact_names(self):
        with patch.dict(
            os.environ,
            {"MSSQL_CLEAR_PROTECTED": " khb_trading,USS_TRADING,, "},
            clear=True,
        ):
            self.assertEqual(
                clear_protected_databases(), {"khb_trading", "uss_trading"}
            )

    def test_clear_protected_actions_changes_only_last_column(self):
        data = {"actions": [(1, "protected", True), (2, "regular", False)]}

        clear_protected_actions(data)

        self.assertEqual(
            data["actions"], [(1, "protected", False), (2, "regular", False)]
        )

    def test_migrations_preserve_configured_order(self):
        with patch.dict(
            os.environ,
            {"MSSQL_MIGRATIONS": "trading:vl,khb_trading:khb,uss_trading:uss"},
        ):
            self.assertEqual(
                migrations(),
                [("trading", "vl"), ("khb_trading", "khb"), ("uss_trading", "uss")],
            )

    def test_migrations_reject_duplicate_target_schema(self):
        with patch.dict(os.environ, {"MSSQL_MIGRATIONS": "one:vl,two:vl"}):
            with self.assertRaises(SystemExit):
                migrations()

    def test_keeps_only_references_reachable_from_actions(self):
        data = {
            "directions": [(1,), (2,)],
            "action_types": [(10, 1), (20, 2)],
            "suboperations_l1": [(100, 10), (200, 20)],
            "suboperations_l2": [(1000, 100), (2000, 200)],
            "currencies": [(1,), (2,), (3,)],
            "accounts": [(11, None, 2), (22, None, 3)],
            "currency_rates": [(1, 1), (2, 2), (3, 3)],
            "legacy_users": [(1,)],
            "actions": [(1, 11, 1000, 1)],
        }

        remove_unused_references(data)

        self.assertEqual(data["directions"], [(1,)])
        self.assertEqual(data["action_types"], [(10, 1)])
        self.assertEqual(data["suboperations_l1"], [(100, 10)])
        self.assertEqual(data["suboperations_l2"], [(1000, 100)])
        self.assertEqual(data["accounts"], [(11, None, 2)])
        self.assertEqual(data["currencies"], [(1,), (2,)])
        self.assertEqual(data["currency_rates"], [(1, 1), (2, 2)])
        self.assertEqual(data["legacy_users"], [(1,)])


if __name__ == "__main__":
    unittest.main()
