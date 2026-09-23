"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable("qa_bbu");
    if (!table.bbu_item_sl_no) {
      await queryInterface.addColumn("qa_bbu", "bbu_item_sl_no", {
        type: Sequelize.STRING,
        allowNull: true,
      });
    }
    if (!table.item_category) {
      await queryInterface.addColumn("qa_bbu", "item_category", {
        type: Sequelize.STRING,
        allowNull: true,
      });
    }
    if (!table.gst_percent) {
      await queryInterface.addColumn("qa_bbu", "gst_percent", {
        type: Sequelize.STRING,
        allowNull: true,
      });
    }
  },

  async down(queryInterface) {
    const table = await queryInterface.describeTable("qa_bbu");
    if (table.gst_percent) await queryInterface.removeColumn("qa_bbu", "gst_percent");
    if (table.item_category) await queryInterface.removeColumn("qa_bbu", "item_category");
    if (table.bbu_item_sl_no) await queryInterface.removeColumn("qa_bbu", "bbu_item_sl_no");
  },
};